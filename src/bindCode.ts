/**
 * API key validation for hookcode workers.
 * API keys use the `hkw_` prefix.
 */

const API_KEY_PREFIX = 'hkw_';

const trimString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const isValidApiKey = (apiKey: string): boolean => {
  const raw = trimString(apiKey);
  return raw.startsWith(API_KEY_PREFIX) && raw.length > API_KEY_PREFIX.length + 8;
};
