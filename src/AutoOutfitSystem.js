import { getContext } from "../../../../extensions.js";
import { extension_settings } from "../../../../extensions.js";

export class AutoOutfitSystem {
    constructor(outfitManager, userManager = null) {
        this.outfitManager = outfitManager;
        this.userManager = userManager; // NEU
        this.isEnabled = false;        this.systemPrompt = this.getDefaultPrompt();
        this.commandPattern = /outfit-system_(\w+)_([\w-]+)\(([^)]*)\)/g;
        this.isProcessing = false;
        this.consecutiveFailures = 0;
        this.maxConsecutiveFailures = 5;
        this.eventHandler = null;
        this.maxRetries = 3;
        this.retryDelay = 2000;
        this.currentRetryCount = 0;
        this.commandQueue = [];
        this.isProcessingQueue = false;
        
        // Track initialization state
        this.appInitialized = false;
    }

    getDefaultPrompt() {
        return `Analyze the actions and descriptions of both the character and the user in the recent messages. If either character or user is described wearing, puts on, removes, or changes any clothing items, output the appropriate outfit commands.

IMPORTANT: Output commands as plain text, NOT as JSON.
Use these exact formats:
For character:
outfit-system_wear_headwear("Red Baseball Cap")
outfit-system_wear_topwear("Black T-Shirt")
outfit-system_remove_topwear()

For user:
user-outfit-system_wear_headwear("Brown Fedora")
user-outfit-system_wear_topwear("Grey T-Shirt")
user-outfit-system_remove_topwear()

Do NOT output JSON arrays, markdown blocks, or any other format.

Available actions: wear, remove, change
Available clothing slots: headwear, topwear, topunderwear, bottomwear, bottomunderwear, footwear, footunderwear
Available accessory slots: head-accessory, ears-accessory, eyes-accessory, mouth-accessory, neck-accessory, body-accessory, arms-accessory, hands-accessory, waist-accessory, bottom-accessory, legs-accessory, foot-accessory

Rules:
1. If an item is mentioned as currently worn and the current outfit slot is "None", output a "wear" command.
2. If an item is explicitly changed or replaced, output a "change" or "wear" command.
3. If an item is removed/taken off, output a "remove" command.
4. If no clothing items or changes are mentioned at all for a person, do not output commands for that person.
5. If neither character nor user has any clothing mentioned or changed, output [none].
6. Always use the exact slot names listed above. Never invent new slot names.`;
    }

    enable() {
        if (this.isEnabled) return '[Outfit System] Auto outfit updates already enabled.';
        
        this.isEnabled = true;
        this.consecutiveFailures = 0;
        this.currentRetryCount = 0;
        this.setupEventListeners();
        return '[Outfit System] Auto outfit updates enabled.';
    }

    disable() {
        if (!this.isEnabled) return '[Outfit System] Auto outfit updates already disabled.';
        
        this.isEnabled = false;
        this.removeEventListeners();
        this.commandQueue = [];
        return '[Outfit System] Auto outfit updates disabled.';
    }

    setupEventListeners() {
        this.removeEventListeners();
        
        const { eventSource, event_types } = getContext();
        
        // Use MESSAGE_RECEIVED instead of CHARACTER_MESSAGE_RENDERED
        // This event fires when new messages are added to chat (before rendering)
        this.eventHandler = (data) => {
            // Only process AI messages (not user messages) and only after app is initialized
            if (this.isEnabled && !this.isProcessing && this.appInitialized && 
                data && !data.is_user) {
                console.log('[AutoOutfitSystem] New AI message received, processing...');
                setTimeout(() => {
                    this.processOutfitCommands().catch(error => {
                        console.error('Auto outfit processing failed:', error);
                        this.consecutiveFailures++;
                    });
                }, 1000); // Shorter delay since we're processing earlier
            }
        };
        
        eventSource.on(event_types.MESSAGE_RECEIVED, this.eventHandler);
        console.log('[AutoOutfitSystem] Event listener registered for MESSAGE_RECEIVED');
    }

    removeEventListeners() {
        if (this.eventHandler) {
            const { eventSource, event_types } = getContext();
            eventSource.off(event_types.MESSAGE_RECEIVED, this.eventHandler);
            this.eventHandler = null;
            console.log('[AutoOutfitSystem] Event listener removed');
        }
    }

    // Mark app as initialized to prevent processing of existing messages
    markAppInitialized() {
        if (!this.appInitialized) {
            this.appInitialized = true;
            console.log('[AutoOutfitSystem] App marked as initialized - will now process new AI messages');
        }
    }

    async processOutfitCommands() {
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            this.disable();
            this.showPopup('Auto outfit updates disabled due to repeated failures.', 'error');
            return;
        }

        if (this.isProcessing) {
            console.log('[AutoOutfitSystem] Already processing, skipping');
            return;
        }
        
        this.isProcessing = true;
        this.currentRetryCount = 0;
        
        try {
            await this.processWithRetry();
        } catch (error) {
            console.error('Outfit command processing failed after retries:', error);
            this.consecutiveFailures++;
            this.showPopup(`Outfit check failed ${this.consecutiveFailures} time(s).`, 'error');
        } finally {
            this.isProcessing = false;
        }
    }

    async processWithRetry() {
        while (this.currentRetryCount < this.maxRetries) {
            try {
                this.showPopup(`Checking for outfit changes... (Attempt ${this.currentRetryCount + 1}/${this.maxRetries})`, 'info');
                
                await this.executeGenCommand();
                
                this.consecutiveFailures = 0;
                this.showPopup('Outfit check completed.', 'success');
                return; // Success!
                
            } catch (error) {
                this.currentRetryCount++;
                
                if (this.currentRetryCount < this.maxRetries) {
                    console.log(`[AutoOutfitSystem] Attempt ${this.currentRetryCount} failed, retrying in ${this.retryDelay}ms...`, error);
                    await this.delay(this.retryDelay);
                } else {
                    throw error; // All retries exhausted
                }
            }
        }
    }
    
    getOutfitStateString() {
        // Dynamically build the outfit string. This avoids regex issues with macros in prompt templates
        // and ensures the LLM sees exactly what we have in memory.
        let output = `Here is what the character and user are currently wearing:\n\n**<BOT>'s Current Outfit**\n`;

        // 1. Bot Clothing
        const clothingSlots = ['headwear', 'topwear', 'topunderwear', 'bottomwear', 'bottomunderwear', 'footwear', 'footunderwear'];
        clothingSlots.forEach(slot => {
            const val = this.outfitManager.currentValues[slot] || 'None';
            const displaySlot = slot.replace('underwear', ' Underwear').replace(/^./, c => c.toUpperCase());
            output += `${displaySlot}: ${val}\n`;
        });

        // 2. Bot Accessories
        output += `\n**<BOT>'s Accessories**\n`;
        const accessorySlots = this.outfitManager.slots.filter(s => !clothingSlots.includes(s));
        accessorySlots.forEach(slot => {
            const val = this.outfitManager.currentValues[slot] || 'None';
            const displaySlot = slot.replace('-', ' ').replace('_', ' ').replace(/^./, c => c.toUpperCase());
            output += `${displaySlot}: ${val}\n`;
        });

        // 3. User Clothing & Accessories (if UserOutfitManager is provided)
        if (this.userManager) {
            output += `\n**User's Current Outfit**\n`;
            clothingSlots.forEach(slot => {
                const val = this.userManager.currentValues[slot] || 'None';
                const displaySlot = slot.replace('underwear', ' Underwear').replace(/^./, c => c.toUpperCase());
                output += `${displaySlot}: ${val}\n`;
            });

            output += `\n**User's Accessories**\n`;
            const userAccessorySlots = this.userManager.slots.filter(s => !clothingSlots.includes(s));
            userAccessorySlots.forEach(slot => {
                const val = this.userManager.currentValues[slot] || 'None';
                const displaySlot = slot.replace('-', ' ').replace('_', ' ').replace(/^./, c => c.toUpperCase());
                output += `${displaySlot}: ${val}\n`;
            });
        }

        return output;
    }

    async executeGenCommand() {
        const recentMessages = this.getLastMessages(3);
        if (!recentMessages.trim()) {
            throw new Error('No valid messages to process');
        }

        const { generateRaw } = getContext();
        
        // Generate the current outfit block dynamically
        const currentOutfitBlock = this.getOutfitStateString();
        
        const promptText = `${this.systemPrompt}\n\n${currentOutfitBlock}\n\nRecent Messages:\n${recentMessages}\n\nOutput:`;
        
        console.log('[AutoOutfitSystem] Generating outfit commands with generateRaw...');
        
        try {
            const result = await generateRaw({
                prompt: promptText,
                systemPrompt: "You are an outfit change detection system. Analyze the conversation and output outfit commands when clothing changes occur."
            });

            if (!result) {
                throw new Error('No output generated from generation');
            }
            
            console.log('[AutoOutfitSystem] Generated result:', result);
            
            const commands = this.parseGeneratedText(result);
            
            if (commands.length > 0) {
                console.log(`[AutoOutfitSystem] Found ${commands.length} commands, processing...`);
                await this.processCommandBatch(commands);
            } else {
                console.log('[AutoOutfitSystem] No outfit commands found in response');
            }
            
        } catch (error) {
            console.error('[AutoOutfitSystem] Generation failed:', error);
            await this.tryFallbackGeneration(promptText);
        }
    }

    async tryFallbackGeneration(promptText) {
        try {
            const { generateQuietPrompt } = getContext();
            
            if (!generateQuietPrompt) {
                throw new Error('generateQuietPrompt not available');
            }
            
            const result = await generateQuietPrompt({
                quietPrompt: promptText
            });

            if (!result) {
                throw new Error('No output generated from fallback generation');
            }
            
            console.log('[AutoOutfitSystem] Fallback result:', result);
            
            const commands = this.parseGeneratedText(result);
            
            if (commands.length > 0) {
                await this.processCommandBatch(commands);
            }
            
        } catch (fallbackError) {
            console.error('[AutoOutfitSystem] Fallback generation also failed:', fallbackError);
            throw new Error(`Both generation methods failed: ${fallbackError.message}`);
        }
    }

    parseGeneratedText(text) {
        if (!text) return [];
        
        const commands = [];
        // Matcht sowohl outfit-system_... als auch user-outfit-system_...
        const matches = text.matchAll(/(user-)?outfit-system_(\w+)_([\w-]+)\(([^)]*)\)/g);
        
        for (const match of matches) {
            commands.push(match[0]);
        }
        
        console.log(`[AutoOutfitSystem] Found ${commands.length} commands:`, commands);
        return commands;
    }


    

    async processCommandBatch(commands) {
        if (!commands || commands.length === 0) {
            console.log('[AutoOutfitSystem] No commands to process');
            return;
        }

        console.log(`[AutoOutfitSystem] Processing batch of ${commands.length} commands`);
        
        const successfulCommands = [];
        const failedCommands = [];
        
        for (const command of commands) {
            try {
                const result = await this.processSingleCommand(command);
                if (result.success) {
                    successfulCommands.push(result);
                } else {
                    failedCommands.push({ command, error: result.error });
                }
            } catch (error) {
                failedCommands.push({ command, error: error.message });
                console.error(`Error processing command "${command}":`, error);
            }
        }
        
        if (successfulCommands.length > 0 && extension_settings.outfit_tracker?.enableSysMessages) {
            console.log(`[AutoOutfitSystem] Showing ${successfulCommands.length} popup messages`);
            
            const messagesByCharacter = {};
            successfulCommands.forEach(({ message }) => {
                const charName = message.match(/(\w+) put on|removed|changed/)?.[1] || 'Character';
                if (!messagesByCharacter[charName]) {
                    messagesByCharacter[charName] = [];
                }
                messagesByCharacter[charName].push(message);
            });
            
            for (const [charName, messages] of Object.entries(messagesByCharacter)) {
                if (messages.length === 1) {
                    this.showPopup(messages[0], 'info');
                } else {
                    this.showPopup(`${charName} made multiple outfit changes.`, 'info');
                }
                await this.delay(1000);
            }
            
            this.updateOutfitPanel();
        }
        
        if (failedCommands.length > 0) {
            console.warn(`[AutoOutfitSystem] ${failedCommands.length} commands failed:`, failedCommands);
        }
        
        console.log(`[AutoOutfitSystem] Batch completed: ${successfulCommands.length} successful, ${failedCommands.length} failed`);
    }

    async processSingleCommand(command) {
        try {
            const match = command.match(/(user-)?outfit-system_(\w+)_([\w-]+)\(([^)]*)\)/);
            if (!match) {
                throw new Error(`Invalid command format: ${command}`);
            }
            
            const [, isUserPrefix, action, slot, value] = match;
            const cleanValue = value.replace(/"/g, '').trim();
            const target = isUserPrefix ? 'user' : 'bot';
            
            console.log(`[AutoOutfitSystem] Processing (${target}): ${action} ${slot} "${cleanValue}"`);
            
            const targetManager = (target === 'user' && this.userManager) ? this.userManager : this.outfitManager;
            const message = await this.executeCommand(action, slot, cleanValue, targetManager);
            
            return {
                success: true,
                command,
                message,
                action,
                slot,
                value: cleanValue,
                target
            };
            
        } catch (error) {
            return {
                success: false,
                command,
                error: error.message
            };
        }
    }

    async executeCommand(action, slot, value, manager = this.outfitManager) {
        const validSlots = [...manager.slots];
        
        if (!validSlots.includes(slot)) {
            throw new Error(`Invalid slot: ${slot}. Valid slots: ${validSlots.join(', ')}`);
        }

        if (!['wear', 'remove', 'change'].includes(action)) {
            throw new Error(`Invalid action: ${action}. Valid actions: wear, remove, change`);
        }

        return await manager.setOutfitItem(slot, action === 'remove' ? 'None' : value);
    }

    updateOutfitPanel() {
        setTimeout(() => {
            try {
                if (window.botOutfitPanel && window.botOutfitPanel.isVisible) {
                    window.botOutfitPanel.outfitManager.loadOutfit();
                    window.botOutfitPanel.renderContent();
                    console.log('[AutoOutfitSystem] Bot outfit panel updated');
                }
                if (window.userOutfitPanel && window.userOutfitPanel.isVisible) {
                    window.userOutfitPanel.outfitManager.loadOutfit(); // HIER: outfitManager statt userManager
                    window.userOutfitPanel.renderContent();
                    console.log('[AutoOutfitSystem] User outfit panel updated');
                }
            } catch (error) {
                console.error('Failed to update outfit panels:', error);
            }
        }, 500);
    }

    getLastMessages(count = 3) {
        try {
            const { chat } = getContext();
            
            if (!chat || !Array.isArray(chat) || chat.length === 0) {
                console.log('[AutoOutfitSystem] No chat or empty chat array');
                return '';
            }
            
            const validMessages = chat.filter(msg => 
                msg && typeof msg === 'object' && 
                typeof msg.mes === 'string' && 
                typeof msg.is_user === 'boolean'
            );
            
            if (validMessages.length === 0) {
                console.log('[AutoOutfitSystem] No valid messages found');
                return '';
            }
            
            const recentMessages = validMessages.slice(-count);
            return recentMessages.map(msg => 
                `${msg.is_user ? 'User' : (msg.name || 'AI')}: ${msg.mes}`
            ).join('\n');
            
        } catch (error) {
            console.error('Error getting last messages:', error);
            return '';
        }
    }

    showPopup(message, type = 'info') {
        try {
            if (typeof toastr !== 'undefined') {
                const options = {
                    timeOut: type === 'error' ? 5000 : 3000,
                    extendedTimeOut: type === 'error' ? 10000 : 5000
                };
                
                switch(type) {
                    case 'error':
                        toastr.error(message, 'Outfit System', options);
                        break;
                    case 'warning':
                        toastr.warning(message, 'Outfit System', options);
                        break;
                    case 'success':
                        toastr.success(message, 'Outfit System', options);
                        break;
                    default:
                        toastr.info(message, 'Outfit System', options);
                }
            }
        } catch (error) {
            console.error('Failed to show popup:', error);
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStatus() {
        return {
            enabled: this.isEnabled,
            hasPrompt: !!this.systemPrompt,
            promptLength: this.systemPrompt?.length || 0,
            isProcessing: this.isProcessing,
            consecutiveFailures: this.consecutiveFailures,
            currentRetryCount: this.currentRetryCount,
            maxRetries: this.maxRetries
        };
    }

    async manualTrigger() {
        if (this.isProcessing) {
            this.showPopup('Auto outfit check already in progress.', 'warning');
            return;
        }
        
        try {
            this.showPopup('Manual outfit check started...', 'info');
            await this.processOutfitCommands();
        } catch (error) {
            this.showPopup(`Manual trigger failed: ${error.message}`, 'error');
        }
    }

    setPrompt(prompt) {
        this.systemPrompt = prompt || this.getDefaultPrompt();
        return '[Outfit System] System prompt updated.';
    }

    resetToDefaultPrompt() {
        this.systemPrompt = this.getDefaultPrompt();
        return '[Outfit System] Reset to default prompt.';
    }
}
