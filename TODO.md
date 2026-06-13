# TODO

- [ ] Fix /antinuke setup SlashCommandBuilder regression: remove invalid subcommand callback chaining; ensure `honeypot_channel` is added as a standard `ChannelOption` under the `setup` subcommand (Discord.js v14 compatible).
- [ ] Fix raid action button registration warnings: update `src/interactions/buttons/raidBanAction.js` and `src/interactions/buttons/raidDismissAction.js` to export the exact required metadata shape expected by the interaction/button loader (match working button files under `src/interactions/buttons/`).
- [ ] Validate: run `node --check` for touched files and run `npm start` (or fortress simulation) to confirm 0 command loader errors and all buttons register.

