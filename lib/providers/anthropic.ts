import Anthropic from '@anthropic-ai/sdk';
import { ModelProvider, CallModelInput, CallModelResult, extractReplyText } from '../model';
import { getModelMaxOutputTokens } from '../config';


let anthropicInstance: Anthropic | null = null;
function getAnthropicInstance(): Anthropic {
  if (!anthropicInstance) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('Warning: ANTHROPIC_API_KEY is not set in environment variables.');
    }
    anthropicInstance = new Anthropic({
      apiKey: apiKey || 'dummy-key',
    });
  }
  return anthropicInstance;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly outputFormat = 'markdown';

  async callModel(input: CallModelInput): Promise<CallModelResult> {
    try {
      const systemContent: any[] = [
        {
          type: 'text',
          text: input.systemPrompt,
        },
      ];

      // Enable prompt caching only if cacheable is true
      if (input.cacheable) {
        systemContent[0].cache_control = { type: 'ephemeral' };
      }

      const headers: Record<string, string> = {};
      if (input.cacheable) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
      }

      // Custom tools go at the start of the cached prefix, so the set must be identical
      // on every call of an answer or the prompt cache resets (§7).
      const tools = input.tools && input.tools.length > 0 ? input.tools : undefined;

      const response = await getAnthropicInstance().messages.create(
        {
          model: input.model,
          max_tokens: getModelMaxOutputTokens(),
          system: systemContent,
          messages: input.conversation ?? [
            {
              role: 'user',
              content: input.document
                ? [
                    {
                      type: 'document',
                      source: {
                        type: 'base64',
                        media_type: input.document.mediaType as 'application/pdf',
                        data: input.document.data,
                      },
                    },
                    {
                      type: 'text',
                      text: input.userMessage,
                    },
                  ]
                : input.userMessage,
            },
          ],
          metadata: { user_id: input.isolationScopeId },
          // The SDK types tools as its own union; ours is the same JSON shape.
          ...(tools ? { tools: tools as any } : {}),
        },
        {
          headers,
        }
      );

      // extractReplyText is only correct on a FINAL response; mid-loop it returns leading
      // narration or an empty string (§7 rule 1). The loop decides which this is — here we
      // always extract, and a loop that is continuing ignores the text and uses `content`.
      const replyText = extractReplyText(response.content);

      return {
        text: replyText,
        content: response.content as any[],
        thinkingTokens:
          (response.usage as any)?.output_tokens_details?.thinking_tokens ?? undefined,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: (response.usage as any).cache_read_input_tokens || 0,
          cache_creation_tokens: (response.usage as any).cache_creation_input_tokens || 0,
        },
        model: response.model,
        requestId: response.id,
        stopReason: response.stop_reason,
      };
    } catch (error: any) {
      console.error('Anthropic API call failed:', error);
      throw error;
    }
  }
}
