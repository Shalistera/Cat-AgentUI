import { config } from './config.js';
import { getSetting } from './db/index.js';

export const ATTACHMENT_COUNT_KEY = 'max_attachments_per_message';
export const ATTACHMENT_COUNT_MAX = 100;

/** Read on each request so admin changes apply without a restart. */
export function maxAttachmentsPerMessage(): number {
  const value = getSetting(ATTACHMENT_COUNT_KEY, config.maxAttachmentsPerMessage);
  return Number.isInteger(value) && value >= 1 && value <= ATTACHMENT_COUNT_MAX
    ? value : config.maxAttachmentsPerMessage;
}
