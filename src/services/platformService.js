// The keys of the connected services (Fitbit, Garmin, Oura, Google). The server refuses everyone except the
// platform owner.
import { callApi } from './apiClient.js';

const post = (body) => callApi('platform', { body });

export const getIntegrationKeys = () => post({ action: 'get' });
export const saveIntegrationKeys = ({ provider, clientId, clientSecret }) => post({ action: 'save', provider, clientId, clientSecret });
export const clearIntegrationKeys = (provider) => post({ action: 'clear', provider });
