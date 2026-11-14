export interface ConfirmationContent {
  title: string;
  message: string;
  fields: { label: string; value: string }[];
  sections: { title: string; body: string; markdown: boolean }[];
  confirmLabel: string;
  dismissLabel: string;
  dark: boolean;
  language: string;
}
