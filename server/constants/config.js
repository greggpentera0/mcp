/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Environment Flag: Is Auth Disabled
 * Local source runs do not need login/setup unless explicitly re-enabled.
 */
export const IS_AUTH_DISABLED = !IS_PLATFORM && process.env.DISABLE_AUTH !== 'false';
