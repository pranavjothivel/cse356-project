Client .env:  
VITE_BACKEND_URL  
VITE_WS_URL - remember this starts with ws:// or wss://  

Server .env:  
DATABASE_URL - postgres connection string  
REDIS_URL - redis connection string  
SESSION_SECRET - set this to whatever you want  
PORT - 3000 if not given  
GOOGLE_CLIENT_ID  
GOOGLE_CLIENT_SECRET  
GOOGLE_CALLBACK_URL - [server url]/auth/google/callback  
GITHUB_CLIENT_ID  
GITHUB_CLIENT_SECRET  
GITHUB_CALLBACK_URL - [server url]/auth/github/callback  
OIDC_ISSUER - see course site  
OIDC_CLIENT_ID - see course site  
OIDC_CLIENT_SECRET - see course site  
OIDC_CALLBACK_URL - [server url]/auth/oidc/callback  
FRONTEND_URL  
JWT_SECRET - set this to whatever you want  
BASE_URL - server url with no port  
UPLOAD_DIR - where uploaded images should go (in production, should be somewhere from which nginx can directly serve them)