import { Collection } from "discord.js";
import timezoneCommand from "./commands/timezone.ts";
import type { Command } from "./types.ts";
import submit from "./commands/submit.ts";
import admin from "./commands/admin.ts";
import scoreboard from "./commands/scoreboard.ts";
import user from "./commands/user.ts";

export const commands = new Collection<string, Command>();

commands.set(timezoneCommand.data.name, timezoneCommand);

// Stats commands
commands.set(scoreboard.data.name, scoreboard);
commands.set(admin.data.name, admin);
commands.set(user.data.name, user);

commands.set(submit.data.name, submit);
