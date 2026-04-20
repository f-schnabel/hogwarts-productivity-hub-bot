import { Collection } from "discord.js";
import timezoneCommand from "./events/interactionCreate/timezone.ts";
import type { Command } from "../common/types.ts";
import submit from "./events/interactionCreate/submit/index.ts";
import admin from "./events/interactionCreate/admin/index.ts";
import scoreboard from "./events/interactionCreate/scoreboard/index.ts";
import user from "./events/interactionCreate/user.ts";

export const commands = new Collection<string, Command>();

commands.set(timezoneCommand.data.name, timezoneCommand);

// Stats commands
commands.set(scoreboard.data.name, scoreboard);
commands.set(admin.data.name, admin);
commands.set(user.data.name, user);

commands.set(submit.data.name, submit);
