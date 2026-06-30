/** Slim workspace-template option for the Create node template picker. */
export interface TemplateOption {
  id: string;
  title: string;
  channel: string | null;
  blockType: string | null;
  tier: string | null;
}
