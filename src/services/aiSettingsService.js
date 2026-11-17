import { callApi } from './apiClient.js';

// The platform-wide AI provider. The server refuses everyone except the platform owner (PLATFORM_ADMIN_EMAILS);
// `status` is the one call open to any signed-in person and only says whether they are the owner.
const post = (body) => callApi('ai', { body });

export const getAiStatus = () => post({ action: 'status' });
export const getAiSettings = () => post({ action: 'get' });
export const saveAiSettings = ({ provider, settings, removeSecrets }) => post({ action: 'save', provider, settings, removeSecrets });
export const testAiSettings = ({ provider, settings, removeSecrets } = {}) => post({ action: 'test', provider, settings, removeSecrets });
export const clearAiSettings = () => post({ action: 'clear' });
