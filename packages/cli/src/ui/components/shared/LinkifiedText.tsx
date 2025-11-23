/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import Link from 'ink-link';

interface LinkifiedTextProps {
  children: string;
  color?: string;
  wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-middle' | 'truncate-start';
}

// Regex to match URLs
const URL_REGEX = /(https?:\/\/[^\s)]+)/g;

export const LinkifiedText: React.FC<LinkifiedTextProps> = ({
  children,
  color,
  wrap,
}) => {
  if (!children) {
    return <Text>{children}</Text>;
  }

  const parts = children.split(URL_REGEX);

  return (
    <Text wrap={wrap} color={color}>
      {parts.map((part, index) => {
        const isUrl = URL_REGEX.test(part);
        const key = `linkified-${index}`;

        if (isUrl) {
          return (
            <Link key={key} url={part}>
              <Text color={color}>{part}</Text>
            </Link>
          );
        }

        return <Text key={key}>{part}</Text>;
      })}
    </Text>
  );
};
