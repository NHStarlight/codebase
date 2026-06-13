import { ApplicationCommandOptionType } from 'discord.js';

const MENTION_REGEX = /^<[@#][!&]?\d+>$/;
const INTEGER_REGEX = /^-?\d+$/;
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

function stripFlags(opts) {
    if (!opts || typeof opts !== 'object') return opts;
    const { flags, ephemeral, ...safe } = opts;
    return safe;
}

function getTextOnlyArgs(args) {
    return args.filter((a) => !MENTION_REGEX.test(a) && !INTEGER_REGEX.test(a));
}

function parseSubcommandTokens(command, textOnlyArgs) {
    const json = command?.data?.toJSON?.() ?? { options: [] };
    const groupNames = new Set(
        (json.options ?? [])
            .filter((o) => o.type === ApplicationCommandOptionType.SubcommandGroup)
            .map((o) => o.name),
    );
    const topSubcommands = new Set(
        (json.options ?? [])
            .filter((o) => o.type === ApplicationCommandOptionType.Subcommand)
            .map((o) => o.name),
    );

    let subcommandGroup = null;
    let subcommand = null;
    let stringArgsStart = 0;

    if (textOnlyArgs.length > 0 && groupNames.has(textOnlyArgs[0])) {
        subcommandGroup = textOnlyArgs[0];
        subcommand = textOnlyArgs[1] ?? null;
        stringArgsStart = 2;
    } else if (textOnlyArgs.length > 0 && topSubcommands.has(textOnlyArgs[0])) {
        subcommand = textOnlyArgs[0];
        stringArgsStart = 1;
    }

    return {
        subcommandGroup,
        subcommand,
        stringArgs: textOnlyArgs.slice(stringArgsStart),
    };
}

function findSnowflake(args) {
    return args.find((a) => SNOWFLAKE_REGEX.test(a)) ?? null;
}

/**
 * Fake interaction for prefix commands (nh!ban @user reason).
 * Uses a single bot reply message for defer/reply/editReply to avoid duplicate success messages.
 */
export function createPrefixInteraction(message, client, command, commandName, args = []) {
    const parsedArgs = [...args];
    const textOnlyArgs = getTextOnlyArgs(parsedArgs);
    const { subcommandGroup, subcommand, stringArgs } = parseSubcommandTokens(command, textOnlyArgs);

    let _deferred = false;
    let _replied = false;
    let _replyMessage = null;

    const sendOrEditReply = async (content) => {
        const opts = stripFlags(typeof content === 'string' ? { content } : content);
        if (_replyMessage) {
            _replyMessage = await _replyMessage.edit(opts);
        } else {
            _replyMessage = await message.reply(opts);
        }
        _replied = true;
        return _replyMessage;
    };

    return {
        _isPrefix: true,
        id: `prefix-${message.id}`,
        createdTimestamp: message.createdTimestamp,
        guildId: message.guild.id,
        channelId: message.channel.id,
        commandName,
        type: 0,
        member: message.member,
        memberPermissions: message.member?.permissions ?? null,
        guild: message.guild,
        channel: message.channel,
        user: message.author,
        client,

        get deferred() {
            return _deferred;
        },
        get replied() {
            return _replied;
        },

        deferReply: async () => {
            _deferred = true;
        },

        reply: sendOrEditReply,
        editReply: sendOrEditReply,

        followUp: async (content) => {
            const opts = stripFlags(typeof content === 'string' ? { content } : content);
            return message.channel.send(opts);
        },

        deleteReply: async () => {
            if (_replyMessage) {
                await _replyMessage.delete().catch(() => {});
                _replyMessage = null;
                _replied = false;
            }
        },

        options: {
            getSubcommandGroup: () => subcommandGroup,
            getSubcommand: () => subcommand,

            getInteger: () => {
                const found = parsedArgs.find((a) => INTEGER_REGEX.test(a));
                return found !== undefined ? parseInt(found, 10) : null;
            },

            getNumber: () => {
                const found = parsedArgs.find((a) => /^-?[\d.]+$/.test(a) && !Number.isNaN(parseFloat(a)));
                return found !== undefined ? parseFloat(found) : null;
            },

            getString: (name) => {
                const mentionUsers = [...message.mentions.users.values()].map((u) => `<@${u.id}>`);
                const snowflakeUsers = parsedArgs.filter(
                    (a) => SNOWFLAKE_REGEX.test(a) && !message.mentions.users.has(a),
                );

                // massban / masskick: users = all @mentions (or IDs), reason = remaining text
                if (name === 'users') {
                    const combined = [...mentionUsers, ...snowflakeUsers];
                    if (combined.length > 0) {
                        return combined.join(' ');
                    }
                    return stringArgs.join(' ') || null;
                }

                if (name === 'reason') {
                    return stringArgs.join(' ') || null;
                }

                return stringArgs.join(' ') || null;
            },

            getUser: () => message.mentions.users.first() ?? null,

            // Sync only — moderation commands use getMember() without await
            getMember: (_name) => {
                const mentioned = message.mentions.members.first();
                if (mentioned) return mentioned;

                const mentionedUser = message.mentions.users.first();
                if (mentionedUser) {
                    return message.guild.members.cache.get(mentionedUser.id) ?? null;
                }

                const id = findSnowflake(parsedArgs);
                return id ? message.guild.members.cache.get(id) ?? null : null;
            },

            getChannel: () =>
                message.mentions.channels.first() ?? message.channel,

            getRole: () => {
                const mentioned = message.mentions.roles.first();
                if (mentioned) return mentioned;
                const id = findSnowflake(parsedArgs);
                return id ? message.guild.roles.cache.get(id) ?? null : null;
            },

            getBoolean: () => {
                const lowered = parsedArgs.map((a) => a.toLowerCase());
                if (lowered.some((a) => ['true', 'yes', 'on', '1'].includes(a))) return true;
                if (lowered.some((a) => ['false', 'no', 'off', '0'].includes(a))) return false;
                return null;
            },

            getAttachment: () => message.attachments.first() ?? null,
        },
    };
}

export function parsePrefixContent(content, prefix) {
    if (!content.toLowerCase().startsWith(prefix.toLowerCase())) return null;

    const trimmed = content.slice(prefix.length).trim();
    if (!trimmed) return null;

    const parts = trimmed.split(/ +/);
    const commandName = parts.shift().toLowerCase();
    return { commandName, args: parts };
}
