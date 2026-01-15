import "dotenv/config";

import { REST, Routes } from "discord.js";
import { commands } from "./commands.ts";
import assert from "node:assert/strict";
import { db } from "./db/db.ts";
import { analyticsServer, server } from "./monitoring.ts";

assert(process.env.CLIENT_ID);
assert(process.env.DISCORD_TOKEN);

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

console.log(`Registering ${commands.size} slash commands`);
await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
  body: commands.map((command) => command.data.toJSON()),
});
console.log("Successfully registered all slash commands");

// We don't need the db connection so just close it
await db.$client.end();

analyticsServer.close();
server.close();
