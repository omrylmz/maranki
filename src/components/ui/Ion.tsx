/**
 * Ionicons — the product's real icon vocabulary (design README: outline
 * variant for inactive states, filled for active). Wraps @expo/vector-icons.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleProp, TextStyle } from 'react-native';

export type IonName = keyof typeof Ionicons.glyphMap;

interface IonProps {
  name: IonName | string;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}

export function Ion({ name, size = 22, color, style }: IonProps) {
  return <Ionicons name={name as IonName} size={size} color={color} style={style} />;
}
