import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Collection } from 'discord.js';
import { logger } from '../utils/logger.js';
import { registerPrefixAliases } from '../utils/commandAliases.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSubcommandInfo(commandData) {
    const subcommands = [];
    if (commandData.options) {
        for (const option of commandData.options) {
            if (option.type === 1) {
                subcommands.push(option.name);
            } else if (option.type === 2) {
                if (option.options) {
                    for (const subOption of option.options) {
                        if (subOption.type === 1) {
                            subcommands.push(`${option.name}/${subOption.name}`);
                        }
                    }
                }
            }
        }
    }
    return subcommands;
}

async function getAllFiles(directory, fileList = []) {
    const files = await fs.readdir(directory, { withFileTypes: true });
    for (const file of files) {
        const filePath = path.join(directory, file.name);
        if (file.isDirectory()) {
            if (file.name === 'modules') continue;
            await getAllFiles(filePath, fileList);
        } else if (file.name.endsWith('.js')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

export async function loadCommands(client) {
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, '../commands');
    const commandFiles = await getAllFiles(commandsPath);
    const filteredCommandFiles = commandFiles.filter(
        (p) => !p.endsWith('/mute.js') && !p.includes('/Moderation/mute.js')
    );
    logger.info(`Found ${filteredCommandFiles.length} command files to load (mute filtered out)`);
    const uniqueCommandNames = new Set();
    for (const filePath of filteredCommandFiles) {
        try {
            const normalizedPath = filePath.replace(/\\/g, '/');
            const commandName = path.basename(filePath, '.js');
            const commandDir = path.dirname(filePath);
            const category = path.basename(commandDir);
            const commandModule = await import(`file://${filePath}`);
            const command = commandModule.default || commandModule;
            if (!command.data || !command.execute) {
                logger.warn(`Command at ${filePath} is missing required "data" or "execute" property.`);
                continue;
            }
            command.category = category;
            command.filePath = normalizedPath;
            const primaryCommandName = command.data.name;
            if (!uniqueCommandNames.has(primaryCommandName)) {
                uniqueCommandNames.add(primaryCommandName);
                client.commands.set(primaryCommandName, command);
            }
            const subcommands = getSubcommandInfo(command.data.toJSON());
            logger.info(`Loaded command: ${primaryCommandName} from ${normalizedPath} (category: ${category})`);
            if (subcommands.length > 0) {
                logger.info(`  - Subcommands: ${subcommands.join(', ')}`);
            }
        } catch (error) {
            logger.error(`Error loading command from ${filePath}:`, error);
        }
    }
    const aliasCount = registerPrefixAliases(client.commands);
    if (aliasCount > 0) {
        logger.info(`Registered ${aliasCount} prefix command aliases`);
    }
    logger.info(`Loaded ${client.commands.size} commands`);
    return client.commands;
}

/**
 * Validate command JSON against Discord limits.
 * Returns array of error strings (empty if valid).
 */
function validateCommands(commands) {
    const errors = [];
    for (const cmd of commands) {
        if (cmd.name && cmd.name.length > 32) {
            errors.push(`Command "${cmd.name}" name exceeds 32 chars (${cmd.name.length})`);
        }
        if (cmd.description && cmd.description.length > 110) {
            errors.push(`Command "${cmd.name}" description exceeds 110 chars (${cmd.description.length})`);
        }
        if (cmd.options) {
            const checkOpts = (opts, prefix) => {
                for (const opt of opts) {
                    if (opt.name && opt.name.length > 32) {
                        errors.push(`${prefix} "${opt.name}" name exceeds 32 chars (${opt.name.length})`);
                    }
                    if (opt.description && opt.description.length > 110) {
                        errors.push(`${prefix} "${opt.name}" description exceeds 110 chars (${opt.description.length})`);
                    }
                    if (opt.choices) {
                        for (const choice of opt.choices) {
                            if (choice.name && choice.name.length > 110) {
                                errors.push(`${prefix} "${opt.name}" choice "${choice.name}" name exceeds 110 chars (${choice.name.length})`);
                            }
                            if (choice.value && choice.value.length > 100) {
                                errors.push(`${prefix} "${opt.name}" choice "${choice.name}" value exceeds 100 chars`);
                            }
                        }
                    }
                    if (opt.options) {
                        checkOpts(opt.options, `${prefix} > ${opt.name}`);
                    }
                }
            };
            checkOpts(cmd.options, `Command "${cmd.name}"`);
        }
    }
    return errors;
}

export async function registerCommands(client, guildId) {
    try {
        const commands = [];
        const registeredNames = new Set();
        for (const command of client.commands.values()) {
            if (command.data && typeof command.data.toJSON === 'function') {
                const commandName = command.data.name;
                if (!registeredNames.has(commandName)) {
                    registeredNames.add(commandName);
                    commands.push(command.data.toJSON());
                    if (process.env.NODE_ENV !== 'production') {
                        logger.debug(`Registering command: ${commandName}`);
                    }
                }
            } else {
                logger.warn(`Command missing data or toJSON method: ${command}`);
            }
        }

        // Validate all commands
        const validationErrors = validateCommands(commands);
        if (validationErrors.length > 0) {
            logger.error('Command validation failed:');
            validationErrors.forEach((e) => logger.error(`  - ${e}`));
            throw new Error(`Command validation failed with ${validationErrors.length} errors`);
        }
        logger.info('Command validation passed');

        const MAX_COMMANDS = 100;
        let commandsToRegister = commands;
        if (commands.length > MAX_COMMANDS) {
            logger.warn(`Command count (${commands.length}) exceeds Discord limit (${MAX_COMMANDS}), truncating...`);
            commandsToRegister = commands.slice(0, MAX_COMMANDS);
        }

        if (guildId) {
            // Guild-specific registration (development/testing)
            const guild = await client.guilds.fetch(guildId);
            const existingCommands = await guild.commands.fetch();
            logger.info(`Found ${existingCommands.size} existing guild commands`);
            await guild.commands.set(commandsToRegister);
            logger.info(`Registered ${commandsToRegister.length} guild commands for ${guild.name} (${guildId})`);
            const registered = await guild.commands.fetch();
            if (registered.size !== commandsToRegister.length) {
                logger.warn(`Expected ${commandsToRegister.length} guild commands, got ${registered.size}`);
            }
        } else {
            // Global registration (production multi-guild)
            logger.info(`Registering ${commandsToRegister.length} commands GLOBALLY (visible in all guilds)...`);
            const existingGlobal = await client.application.commands.fetch();
            logger.info(`Found ${existingGlobal.size} existing global commands`);
            await client.application.commands.set(commandsToRegister);
            logger.info(`Successfully registered ${commandsToRegister.length} global commands`);
            const registered = await client.application.commands.fetch();
            if (registered.size !== commandsToRegister.length) {
                logger.warn(`Expected ${commandsToRegister.length} global commands, got ${registered.size}`);
            } else {
                logger.info(`Verification passed: ${registered.size} global commands registered`);
            }
        }
    } catch (error) {
        logger.error('Error registering commands:', error);
        throw error;
    }
}

export async function reloadCommand(client, commandName) {
    const command = client.commands.get(commandName);
    if (!command) {
        return { success: false, message: `Command "${commandName}" not found` };
    }
    try {
        const commandPath = path.resolve(command.filePath);
        const moduleUrl = pathToFileURL(commandPath);
        moduleUrl.searchParams.set('t', Date.now().toString());
        const newCommand = (await import(moduleUrl.href)).default;
        client.commands.set(commandName, newCommand);
        logger.info(`Reloaded command: ${commandName}`);
        return { success: true, message: `Successfully reloaded command "${commandName}"` };
    } catch (error) {
        logger.error(`Error reloading command "${commandName}":`, error);
        return { success: false, message: `Error reloading command: ${error.message}` };
    }
}