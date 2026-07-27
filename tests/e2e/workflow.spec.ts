import { expect, test } from '@playwright/test';

/**
 * Covers the path a new user actually takes: install a template, open it on the
 * canvas, run it, and read the result. Everything runs against the offline
 * provider, so this needs no keys and is deterministic.
 */
test.describe('workflow lifecycle', () => {
  test('installs a template, runs it, and shows a trace', async ({ page, request }) => {
    await page.goto('/marketplace');
    await expect(page.getByRole('heading', { name: 'Marketplace' })).toBeVisible();
    await expect(page.getByText('RAG Question Answering')).toBeVisible();

    // Install through the API so the test asserts on the editor, not the click path.
    const install = await request.post('/api/templates/tpl_rag/install');
    expect(install.ok()).toBeTruthy();
    const { workflow } = (await install.json()) as { workflow: { id: string } };

    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByRole('button', { name: /^Run$/ })).toBeVisible();
    await expect(page.getByText('Valid')).toBeVisible();

    const run = await request.post(`/api/workflows/${workflow.id}/run`, {
      data: {
        stream: false,
        input: {
          question: 'What is the refund window?',
          documents: ['Refunds are accepted within 30 days of delivery.'],
        },
      },
    });
    expect(run.ok()).toBeTruthy();

    const { trace } = (await run.json()) as {
      trace: { status: string; order: string[]; usage: { totalTokens: number } };
    };
    expect(trace.status).toBe('succeeded');
    // Retrieval found the document, so the LLM branch ran and the fallback did not.
    expect(trace.order).toContain('answer');
    expect(trace.usage.totalTokens).toBeGreaterThan(0);

    await page.goto('/runs');
    await expect(page.getByText('succeeded').first()).toBeVisible();
  });

  test('rejects an unauthenticated call to a token-protected deployment', async ({
    request,
  }) => {
    const install = await request.post('/api/templates/tpl_rag/install');
    const { workflow } = (await install.json()) as { workflow: { id: string } };

    await request.post(`/api/workflows/${workflow.id}/versions`, {
      data: { action: 'publish', changelog: 'e2e' },
    });
    const created = await request.post('/api/deployments', {
      data: { workflowId: workflow.id, kind: 'rest', requireToken: true },
    });
    const { deployment, token } = (await created.json()) as {
      deployment: { slug: string };
      token: string;
    };

    const anonymous = await request.post(`/api/v1/${deployment.slug}`, { data: {} });
    expect(anonymous.status()).toBe(401);

    const authorised = await request.post(`/api/v1/${deployment.slug}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { question: 'refund window', documents: ['Refunds within 30 days.'] },
    });
    expect(authorised.ok()).toBeTruthy();
  });

  test('validation surfaces an error for an empty required input', async ({
    page,
    request,
  }) => {
    const created = await request.post('/api/workflows', {
      data: { name: 'Validation probe' },
    });
    const { workflow } = (await created.json()) as { workflow: { id: string } };

    // An Output node with nothing feeding its required input.
    await request.patch(`/api/workflows/${workflow.id}`, {
      data: {
        graph: {
          id: workflow.id,
          name: 'Validation probe',
          nodes: [
            {
              id: 'out',
              type: 'flowforge.output',
              position: { x: 0, y: 0 },
              config: { name: 'r' },
            },
          ],
          edges: [],
        },
      },
    });

    await page.goto(`/workflows/${workflow.id}`);
    await expect(page.getByText(/error/i).first()).toBeVisible();
  });
});
