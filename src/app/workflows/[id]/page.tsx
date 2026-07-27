import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { Editor } from '@/components/editor/editor';
import { getRuntime } from '@/server/runtime';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const { store } = await getRuntime();
  const record = await store.getWorkflow(id);
  return { title: record?.name ?? 'Editor' };
}

export default async function WorkflowEditorPage({ params }: Params) {
  const { id } = await params;
  const { store } = await getRuntime();

  const record = await store.getWorkflow(id);
  if (!record) notFound();

  const graph = await store.resolveGraph(id, record.draftVersion);
  if (!graph) notFound();

  return (
    <Editor
      workflowId={id}
      initialGraph={graph}
      initialName={record.name}
      draftVersion={record.draftVersion}
      publishedVersion={record.publishedVersion}
    />
  );
}
