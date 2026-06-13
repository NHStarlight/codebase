import { MockRole } from './MockRole.js';

/**
 * Mock Discord.js CommandInteraction (slash command) for unit testing.
 * Supports getSubcommand, getSubcommandGroup, and all option types.
 */
export class MockInteraction {
    constructor({
        id = 'interaction-001',
        commandName = 'test',
        guild = null,
        channel = null,
        member = null,
        user = null,
        options = {},
        client = null,
        deferred = false,
    } = {}) {
        this.id = id;
        this.commandName = commandName;
        this.guild = guild;
        this.guildId = guild?.id || 'guild-001';
        this.channel = channel;
        this.member = member;
        this.user = user || (member?.user) || { id: 'user-001', tag: 'User#0001', bot: false };
        this.client = client;
        this.createdTimestamp = Date.now();
        this.type = 2; // CHAT_INPUT

        this._deferred = false;
        this._replied = false;
        this._replyContent = null;
        this._ephemeral = false;
        this._followUps = [];
        this._editedContent = null;
        this._options = options;
        this._isPrefix = false;

        // Stub reply/editReply/followUp/deleteReply + InteractionHelper patching support
        this.reply = async (content) => {
            this._replied = true;
            this._replyContent = content;
            this._ephemeral = content?.ephemeral || content?.flags === 64;
            return Promise.resolve();
        };
        this.editReply = async (content) => {
            this._editedContent = content;
            return Promise.resolve({ id: 'reply-001', ...content });
        };
        this.deferReply = async (options) => {
            this._deferred = true;
            if (options?.ephemeral || options?.flags === 64) {
                this._ephemeral = true;
            }
            return Promise.resolve();
        };
        this.followUp = async (content) => {
            this._followUps.push(content);
            return Promise.resolve({ id: 'followup-001' });
        };
        this.deleteReply = async () => {
            this._replyContent = null;
            return Promise.resolve();
        };
        this.showModal = async () => Promise.resolve();

        // For prefix adapter: store a fake "replied/deferred" flags
        Object.defineProperty(this, 'replied', { get: () => this._replied, configurable: true });
        Object.defineProperty(this, 'deferred', { get: () => this._deferred, configurable: true });
    }

    get options() {
        const self = this;
        return {
            _data: self._options,
            getSubcommandGroup: () => self._options._subcommandGroup || null,
            getSubcommand: (required) => {
                return self._options._subcommand || null;
            },
            getString: (name) => self._options[name] || null,
            getInteger: (name) => self._options[name] ?? null,
            getNumber: (name) => self._options[name] ?? null,
            getBoolean: (name) => self._options[name] ?? null,
            getUser: (name, required) => {
                const user = self._options[name];
                return user || null;
            },
            getMember: (name) => {
                const member = self._options[name];
                return member || null;
            },
            getChannel: (name, required) => {
                return self._options[name] || null;
            },
            getRole: (name, required) => {
                return self._options[name] || null;
            },
            getAttachment: (name) => null,
            getMentionable: (name) => null,
            data: [],
        };
    }

    isChatInputCommand() {
        return true;
    }

    isButton() {
        return false;
    }

    isStringSelectMenu() {
        return false;
    }

    isModalSubmit() {
        return false;
    }
}

/**
 * Create a slash interaction from an options object for quick test setup.
 * @param {object} overrides
 * @returns {MockInteraction}
 */
export function createSlashInteraction(overrides = {}) {
    return new MockInteraction(overrides);
}

export default MockInteraction;