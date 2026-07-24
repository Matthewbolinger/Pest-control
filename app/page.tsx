import { FieldProofApp } from "@/components/fieldproof-app";
import { requireChatGPTUser } from "@/app/chatgpt-auth";

export const dynamic = "force-dynamic";

export default function Home() {
  return <AuthenticatedFieldProof />;
}

async function AuthenticatedFieldProof() {
  await requireChatGPTUser("/");
  return <FieldProofApp />;
}
