import { useCallback, useEffect, useRef, useState } from 'react';
import { VOICE_MAX_SECONDS, baseMime, canRecordVoice, microphoneErrorKey, pickRecorderMime } from '../services/voiceUtils.js';

// Records one voice message with MediaRecorder: idle -> requesting -> recording -> preview.
// The recording is kept in memory (and as a local object URL for the preview) until it is sent or discarded.
export default function useVoiceRecorder() {
  const [state, setState] = useState('idle');
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(null);
  const [errorKey, setErrorKey] = useState('');

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const cancelledRef = useRef(false);
  const urlRef = useRef('');

  const release = useCallback(() => {
    window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const clearRecording = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = '';
    setRecording(null);
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    recorderRef.current = null;
    release();
    clearRecording();
    setSeconds(0);
    setErrorKey('');
    setState('idle');
  }, [release, clearRecording]);

  const start = useCallback(async () => {
    setErrorKey('');
    if (!canRecordVoice()) {
      setErrorKey('voiceErrUnsupported');
      return;
    }
    clearRecording();
    setState('requesting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      setErrorKey(microphoneErrorKey(error));
      setState('idle');
      return;
    }

    try {
      const mime = pickRecorderMime((type) => MediaRecorder.isTypeSupported?.(type));
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelledRef.current = false;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        cancelledRef.current = true;
        release();
        setErrorKey('voiceErrUnsupported');
        setState('idle');
      };
      recorder.onstop = () => {
        release();
        if (cancelledRef.current) return;
        const type = baseMime(recorder.mimeType || mime || chunksRef.current[0]?.type);
        const blob = new Blob(chunksRef.current, { type });
        const elapsed = Math.min((Date.now() - startedAtRef.current) / 1000, VOICE_MAX_SECONDS);
        urlRef.current = URL.createObjectURL(blob);
        setSeconds(elapsed);
        setRecording({ blob, url: urlRef.current, seconds: Math.round(elapsed), mime: type });
        setState('preview');
      };

      startedAtRef.current = Date.now();
      setSeconds(0);
      recorder.start();
      setState('recording');
      timerRef.current = window.setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        setSeconds(Math.min(elapsed, VOICE_MAX_SECONDS));
        if (elapsed >= VOICE_MAX_SECONDS) stop();
      }, 250);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      setErrorKey(microphoneErrorKey(error));
      setState('idle');
    }
  }, [clearRecording, release, stop]);

  // Leaving the conversation stops the microphone.
  useEffect(() => () => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    release();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, [release]);

  return { state, seconds, recording, errorKey, start, stop, reset };
}
