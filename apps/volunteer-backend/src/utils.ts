import { INTEREST_SET } from "./constants/interests";

export function normalizeInterests(interests: string[]): string[] {
  return [...new Set(interests.map((value) => value.trim().toLowerCase()))];
}

export function validateInterests(interests: string[]): { valid: boolean; invalid: string[] } {
  const invalid = interests.filter((interest) => !INTEREST_SET.has(interest));

  return {
    valid: invalid.length === 0,
    invalid,
  };
}

export function normalizeTopics(topics: string[]): string[] {
  return [...new Set(topics.map((topic) => topic.trim().toLowerCase()).filter(Boolean))];
}

export function toIsoNow(): string {
  return new Date().toISOString();
}
