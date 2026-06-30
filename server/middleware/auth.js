import jwt from 'jsonwebtoken';
import { userDb, appConfigDb } from '../modules/database/index.js';
import { IS_AUTH_DISABLED, IS_PLATFORM } from '../constants/config.js';

// Use env var if set, otherwise auto-generate a unique secret per installation
const JWT_SECRET = process.env.JWT_SECRET || appConfigDb.getOrCreateJwtSecret();
const LOCAL_AUTH_DISABLED_USERNAME = 'local-user';
const LOCAL_AUTH_DISABLED_PASSWORD_HASH = '__cloudcli_auth_disabled_local_user__';

const isLocalAuthDisabledUser = (user) => (
  Boolean(user)
  && user.username === LOCAL_AUTH_DISABLED_USERNAME
  && user.password_hash === LOCAL_AUTH_DISABLED_PASSWORD_HASH
);

const normalizeAuthenticatedUser = (user) => ({
  id: user.id,
  userId: user.id,
  username: user.username,
  created_at: user.created_at,
  last_login: user.last_login,
});

const getOrCreateLocalAuthUser = () => {
  const existingUser = userDb.getFirstUser();
  if (existingUser) {
    return existingUser;
  }

  try {
    const createdUser = userDb.createUser(
      LOCAL_AUTH_DISABLED_USERNAME,
      LOCAL_AUTH_DISABLED_PASSWORD_HASH
    );
    const userId = Number(createdUser.id);
    userDb.completeOnboarding(userId);
    return userDb.getUserById(userId) || {
      id: userId,
      username: createdUser.username,
      created_at: new Date().toISOString(),
      last_login: null,
    };
  } catch (error) {
    const localUser = userDb.getFirstUser();
    if (localUser) {
      return localUser;
    }

    throw error;
  }
};

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  // Skip API key validation if not configured
  if (!process.env.API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  if (IS_AUTH_DISABLED) {
    try {
      req.user = getOrCreateLocalAuthUser();
      return next();
    } catch (error) {
      console.error('Auth-disabled local user error:', error);
      return res.status(500).json({ error: 'Failed to initialize local user' });
    }
  }

  // Platform mode:  use single database user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Normal OSS JWT validation
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  // Also check query param for SSE endpoints (EventSource can't set headers)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user still exists and is active
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token. User not found.' });
    }

    // Auto-refresh: if token is past halfway through its lifetime, issue a new one
    if (decoded.exp && decoded.iat) {
      const now = Math.floor(Date.now() / 1000);
      const halfLife = (decoded.exp - decoded.iat) / 2;
      if (now > decoded.iat + halfLife) {
        const newToken = generateToken(user);
        res.setHeader('X-Refreshed-Token', newToken);
      }
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// WebSocket authentication function
const authenticateWebSocket = (token) => {
  if (IS_AUTH_DISABLED) {
    try {
      return normalizeAuthenticatedUser(getOrCreateLocalAuthUser());
    } catch (error) {
      console.error('Auth-disabled local WebSocket error:', error);
      return null;
    }
  }

  // Platform mode: bypass token validation, return first user
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (user) {
        return normalizeAuthenticatedUser(user);
      }
      return null;
    } catch (error) {
      console.error('Platform mode WebSocket error:', error);
      return null;
    }
  }

  // Normal OSS JWT validation
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user actually exists in database (matches REST authenticateToken behavior)
    const user = userDb.getUserById(decoded.userId);
    if (!user) {
      return null;
    }
    return { userId: user.id, username: user.username };
  } catch (error) {
    console.error('WebSocket token verification error:', error);
    return null;
  }
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  getOrCreateLocalAuthUser,
  isLocalAuthDisabledUser,
  LOCAL_AUTH_DISABLED_PASSWORD_HASH,
  LOCAL_AUTH_DISABLED_USERNAME,
  JWT_SECRET
};
