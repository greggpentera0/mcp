import { useState, useEffect } from 'react';

import { version } from '../../package.json';

export const useVersionCheck = () => {
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        // `data.version` is the version the server process is actually running.
        // This module's `version` is baked into the frontend bundle at build
        // time, so a mismatch means the server process needs a restart.
        if (typeof data.version === 'string' && data.version.length > 0) {
          setRestartRequired(data.version !== version);
        }
      } catch {
        // Keep the restart hint hidden when /health is unavailable.
      }
    };
    fetchHealth();
  }, []);

  return { currentVersion: version, restartRequired };
};
