'use strict';

// SERVER-ONLY CONFIGURATION.
// This file must remain beside server.js and must NEVER be placed in /public.
// Add your Supabase secret key below. Do not use the publishable key here.

module.exports = {
  discord: {
    clientId: '',
    clientSecret: '',
    redirectUri: 'https://YOUR-SERVICE.onrender.com/auth/discord/callback',
    sessionSecret: 'REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS',
    managementDiscordIds: [
      // 'YOUR_DISCORD_USER_ID'
    ]
  },
  supabase: {
    url: 'https://aevjkzbfjjctfxcfjsjv.supabase.co',
    secretKey: 'PASTE_YOUR_SB_SECRET_KEY_HERE'
  }
};
