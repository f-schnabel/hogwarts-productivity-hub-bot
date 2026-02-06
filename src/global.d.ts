export declare global {
  namespace NodeJS {
    interface ProcessEnv {
      DB_NAME: string;
      DB_USER: string;
      DB_PASSWORD: string;
      DB_HOST: string;
      OWNER_ID: string;
      GRYFFINDOR_ROLE_ID: string;
      SLYTHERIN_ROLE_ID: string;
      HUFFLEPUFF_ROLE_ID: string;
      RAVENCLAW_ROLE_ID: string;
      DISCORD_TOKEN: string;
      NODE_ENV: "development" | "production" | "test";
      EXCLUDE_VOICE_CHANNEL_IDS?: string;
      CLIENT_ID: string;
      GUILD_ID: string;
      PREFECT_ROLE_ID: string;
      PROFESSOR_ROLE_ID: string;
      VC_ROLE_ID: string;
      SUBMISSION_CHANNEL_IDS: string;
      YEAR_ROLE_IDS: string;
      YEAR_ANNOUNCEMENT_CHANNEL_ID: string;
      GRYFFINDOR_CREST_EMOJI_ID: string;
      SLYTHERIN_CREST_EMOJI_ID: string;
      HUFFLEPUFF_CREST_EMOJI_ID: string;
      RAVENCLAW_CREST_EMOJI_ID: string;
    }
  }
}
