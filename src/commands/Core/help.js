import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { createInitialHelpMenu } from '../../utils/helpMenuHelper.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show the nh_starlightsercurity command list and categories'),

    async execute(interaction, guildConfig, client) {
        const activeClient = client || interaction.client;
        const isPrefix = interaction._isPrefix === true;

        if (!isPrefix) {
            await InteractionHelper.safeDefer(interaction, {
                flags: MessageFlags.Ephemeral,
            });
        }

        const { embeds, components } = await createInitialHelpMenu(activeClient);
        await InteractionHelper.safeEditReply(interaction, {
            embeds,
            components,
            flags: isPrefix ? undefined : MessageFlags.Ephemeral,
        });
    },
};
