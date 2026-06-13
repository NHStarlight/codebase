import {
    getCategoryEmbedAndPageCount,
    getAllCommandsEmbedAndPageCount,
    buildHelpViewComponents,
} from '../../utils/helpMenuHelper.js';
import { logger } from '../../utils/logger.js';

export default {
    name: 'help',
    async execute(interaction, client, args) {
        try {
            // customId: help:back|next:<targetPage>:<category>
            const targetPage = parseInt(args[1], 10) || 1;
            const category = args[2] || 'help-all-commands';

            let result;
            if (category === 'help-all-commands') {
                result = await getAllCommandsEmbedAndPageCount(targetPage, client);
            } else {
                result = await getCategoryEmbedAndPageCount(category, targetPage, client);
            }

            const { embed, totalPages, currentPage } = result;
            const components = await buildHelpViewComponents(client, currentPage, totalPages, category);

            await interaction.editReply({
                embeds: [embed],
                components,
            });
        } catch (error) {
            logger.error('Error in help button handler:', error);
            await interaction.editReply({ content: '❌ An error occurred while updating the help menu.' });
        }
    }
};
