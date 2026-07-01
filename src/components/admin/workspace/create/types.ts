/** Slim workspace-template option for the Create node template picker. */
export interface TemplateOption {
  id: string;
  title: string;
  channel: string | null;
  blockType: string | null;
  tier: string | null;
  /** Presentation STYLE / content angle (src/lib/content/frameworks.ts), if classified. */
  framework: string | null;
}
