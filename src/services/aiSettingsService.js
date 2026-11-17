import { callApi } from './apiClient.js';

// The coach's AI provider settings. The server refuses everyone who is not the account owner.
const post = (body) => callApi('ai', { body });

export const getAiSettings = () => post({ action: 'get' });
export const saveAiSettings = ({ provider, settings, removeSecrets }) => post({ action: 'save', provider, settings, removeSecrets });
export const testAiSettings = ({ provider, settings, removeSecrets } = {}) => post({ action: 'test', provider, settings, removeSecrets });
export const clearAiSettings = () => post({ action: 'clear' });
