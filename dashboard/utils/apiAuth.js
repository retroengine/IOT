/**
 * apiAuth.js — Smart Grid Sentinel API Key Storage
 * dashboard_ip variant only. Do not include in dashboard (remote).
 *
 * Stores the X-API-Key used by every ESP32 REST call.
 * Imported only by main.js — the fetch interceptor there handles
 * injection universally so no component or page file needs to change.
 *
 * Key storage: localStorage key 'sgs_api_key'
 * Key is never sent to any origin other than window.location.origin.
 *
 * Public API:
 *   getKey()        → string  — current key, '' if not set
 *   setKey(key)     → void    — persist key to localStorage
 *   clearKey()      → void    — remove key from localStorage
 *   isConfigured()  → boolean — true when a non-empty key exists
 */

const LS_KEY = 'sgs_api_key';

/** Return the stored API key, or empty string if not configured. */
export function getKey() {
  return localStorage.getItem(LS_KEY) || '';
}

/** Persist a new API key. Pass an empty string to effectively clear it. */
export function setKey(key) {
  if (typeof key !== 'string') return;
  if (key.trim() === '') {
    clearKey();
    return;
  }
  localStorage.setItem(LS_KEY, key.trim());
}

/** Remove the stored API key entirely. */
export function clearKey() {
  localStorage.removeItem(LS_KEY);
}

/** True when a non-empty key is stored. */
export function isConfigured() {
  return Boolean(getKey());
}