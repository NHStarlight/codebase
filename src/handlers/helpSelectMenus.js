import {
    getCategoryEmbedAndPageCount,
    getAllCommandsEmbedAndPageCount,
    buildHelpViewComponents,
    ALL_COMMANDS_ID,
} from '../utils/helpMenuHelper.js';
import { logger } from '../utils/logger.js';
import { MessageFlags } from 'discord.js';

export const helpCategorySelectMenu = {
    name: 'help-category-select',
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }

            const selectedCategory = interaction.values[0];
            let result;

            if (selectedCategory === ALL_COMMANDS_ID) {
                result = await getAllCommandsEmbedAndPageCount(1, client);
            } else {
                result = await getCategoryEmbedAndPageCount(selectedCategory, 1, client);
            }

            const { embed, totalPages } = result;
            const components = await buildHelpViewComponents(client, 1, totalPages, selectedCategory);

            await interaction.editReply({
                embeds: [embed],
                components,
            });
        } catch (error) {
            logger.error('Error in help category select menu handler:', error);

            if (error?.code === 40060 || error?.code === 10062) {
                return;
            }

            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ An error occurred while loading help categories.',
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    },
};
