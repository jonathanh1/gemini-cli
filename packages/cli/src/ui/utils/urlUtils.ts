/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regex to match HTTP/HTTPS URLs (case-insensitive).
 * Matches starting with http/https, followed by any non-whitespace characters.
 * Uses a negated character class to exclude trailing punctuation
 * that is commonly found after URLs in text.
 */
export const URL_REGEX = /(https?:\/\/[^\s]*[^.,;:!?\s)\]}])/i;

// Pre-compiled regex for checking if a string is a complete URL
const URL_MATCH_PATTERN = new RegExp(`^${URL_REGEX.source}$`, 'i');

/**
 * Check if a string is a valid URL matching our URL_REGEX pattern.
 */
export const isUrl = (text: string): boolean => URL_MATCH_PATTERN.test(text);
