/**
 * Jest Test Setup
 * Global test configuration and mocks
 */
import { afterEach, vi } from "vitest";

// Mock environment variables for testing
process.env.NODE_ENV = "test";
process.env.DB_NAME = "discord_bot_test";
process.env.DISCORD_TOKEN = "test-token";
process.env.SUBMISSION_CHANNEL_IDS = "";
process.env.YEAR_ROLE_IDS = "";

// Mock console methods in tests to reduce noise
globalThis.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Mock Discord.js for testing
vi.mock("discord.js", () => ({
  Client: class MockClient {
    commands = new Map();
    login = vi.fn();
    on = vi.fn();
    user = { id: "test-bot-id" };
    users = {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn(),
      }),
    };
    channels = {
      fetch: vi.fn(),
    };
    guilds = {
      cache: new Map(),
    };
  },
  IntentsBitField: {
    Flags: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      GuildMembers: 8,
      GuildVoiceStates: 16,
      DirectMessages: 32,
    },
  },
  SlashCommandBuilder: class MockSlashCommandBuilder {
    setName() {
      return this;
    }
    setDescription() {
      return this;
    }
    addStringOption(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandOption());
      return this;
    }
    addIntegerOption(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandOption());
      return this;
    }
    addBooleanOption(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandOption());
      return this;
    }
    addUserOption(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandOption());
      return this;
    }
    addAttachmentOption(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandOption());
      return this;
    }
    addSubcommand(fn: (opt: unknown) => unknown) {
      fn(new MockSlashCommandBuilder());
      return this;
    }
    toJSON() {
      return {};
    }
  },
  EmbedBuilder: class MockEmbedBuilder {
    setTitle() {
      return this;
    }
    setDescription() {
      return this;
    }
    setColor() {
      return this;
    }
    addFields() {
      return this;
    }
    setFooter() {
      return this;
    }
    setTimestamp() {
      return this;
    }
  },
  Collection: Map,
}));

class MockSlashCommandOption {
  setName() {
    return this;
  }
  setDescription() {
    return this;
  }
  setRequired() {
    return this;
  }
  addChoices() {
    return this;
  }
  setMinValue() {
    return this;
  }
  setMaxValue() {
    return this;
  }
  setAutocomplete() {
    return this;
  }
}

// Cleanup after each test
afterEach(() => {
  vi.clearAllMocks();
});
