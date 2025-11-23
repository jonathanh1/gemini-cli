/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import Link from 'ink-link';
import type { AnsiLine, AnsiOutput, AnsiToken } from '@google/gemini-cli-core';

const DEFAULT_HEIGHT = 24;

interface AnsiOutputProps {
  data: AnsiOutput;
  availableTerminalHeight?: number;
  width: number;
}

// Regex to match URLs
const URL_REGEX = /(https?:\/\/[^\s)]+)/g;

export const AnsiOutputText: React.FC<AnsiOutputProps> = ({
  data,
  availableTerminalHeight,
  width,
}) => {
  const lastLines = data.slice(
    -(availableTerminalHeight && availableTerminalHeight > 0
      ? availableTerminalHeight
      : DEFAULT_HEIGHT),
  );

  const renderToken = (token: AnsiToken, keyPrefix: string) => {
    const parts = token.text.split(URL_REGEX);
    return parts.map((part, index) => {
      const isUrl = URL_REGEX.test(part);
      const key = `${keyPrefix}-${index}`;

      if (isUrl) {
        return (
          <Link key={key} url={part}>
            <Text
              color={token.inverse ? token.bg : token.fg}
              backgroundColor={token.inverse ? token.fg : token.bg}
              dimColor={token.dim}
              bold={token.bold}
              italic={token.italic}
              underline={token.underline}
            >
              {part}
            </Text>
          </Link>
        );
      }

      return (
        <Text
          key={key}
          color={token.inverse ? token.bg : token.fg}
          backgroundColor={token.inverse ? token.fg : token.bg}
          dimColor={token.dim}
          bold={token.bold}
          italic={token.italic}
          underline={token.underline}
        >
          {part}
        </Text>
      );
    });
  };

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {lastLines.map((line: AnsiLine, lineIndex: number) => (
        <Text key={lineIndex} wrap="truncate">
          {line.length > 0
            ? line.map((token: AnsiToken, tokenIndex: number) =>
                renderToken(token, `${lineIndex}-${tokenIndex}`),
              )
            : null}
        </Text>
      ))}
    </Box>
  );
};
