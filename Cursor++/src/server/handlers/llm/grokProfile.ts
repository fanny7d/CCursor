export function usesGrokResponsesTools(provider: string, model?: string): boolean {
  return provider === 'openai-responses'
    && /^(?:(?:xai|x-ai|grok)\/)?grok-/i.test(model ?? '')
}
