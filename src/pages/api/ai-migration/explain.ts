import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MIGRATION_MODEL } from '../../../lib/ai-migration/model';

export interface ExplainFix {
  action: string;
  code: string | null;
}

export interface ExplainResponse {
  summary: string;
  rootCause: string;
  fixes: ExplainFix[];
  preventionTip: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { error, context } = req.body as { error: string; context?: string };

  if (!error?.trim()) {
    return res.status(400).json({ error: 'error text is required' });
  }

  try {
    const client = new Anthropic();
    const message = await client.messages.create({
      model: AI_MIGRATION_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a PostgreSQL expert helping debug a MySQL→PostgreSQL migration error.

Error message:
${error.trim()}
${context?.trim() ? `\nMigration context:\n${context.trim()}` : ''}

Return ONLY valid JSON (no markdown fences):
{
  "summary": "plain English one-sentence explanation of what went wrong",
  "rootCause": "technical root cause explaining why this error occurs",
  "fixes": [
    {
      "action": "specific step to fix the issue",
      "code": "SQL or code snippet if applicable, otherwise null"
    }
  ],
  "preventionTip": "how to detect or prevent this issue before running migration"
}`,
      }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return res.status(500).json({ error: 'No text response from AI' });
    }

    let parsed: ExplainResponse;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      const match = textBlock.text.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text });
      parsed = JSON.parse(match[0]);
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
