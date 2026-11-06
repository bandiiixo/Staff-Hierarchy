'use strict';

// SERVER-ONLY CONFIGURATION.
// This file must remain beside server.js and must NEVER be placed in /public.
// Add your Supabase secret key below. Do not use the publishable key here.

module.exports = {
  discord: {
    clientId: '',
    clientSecret: '',
    redirectUri: 'https://YOUR-SERVICE.onrender.com/auth/discord/callback',
    sessionSecret: 'dc515a4ccc6ccd9d9660d4231d7ac9a997d4931e7681f7aea8fefb9280b8b42f7343c262504fc634b78d800cb583e919',
    managementDiscordIds: [
       '634491499576557596',
      '989965219579166780'
    ]
  },
  supabase: {
    url: 'https://tmxpcifrbenxkweccrsi.supabase.co',
    secretKey: 'sb_secret_6lokiPz1FXLhCg6sspj-Sg_IAd1K4B4'
  }
};
