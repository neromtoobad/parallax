import { notFound } from 'next/navigation';
import { HireForm } from '@/components/HireForm';
import { serviceById } from '@/lib/catalog';

export default async function HirePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const svc = serviceById(id);
  if (!svc) notFound();
  return <HireForm id={svc.id} />;
}
