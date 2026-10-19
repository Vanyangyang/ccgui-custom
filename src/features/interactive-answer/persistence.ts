import { invoke } from "@/lib/transport";
import type { AnswerState } from "./protocol";

export interface AnswerSnapshot { revision: number; values: AnswerState; sourceHash: string }
export interface AnswerPersistence {
  read(identity: string, source: string): Promise<AnswerSnapshot>;
  write(identity: string, source: string, expectedRevision: number, values: AnswerState, reset: boolean): Promise<AnswerSnapshot>;
}
export const answerPersistence: AnswerPersistence = {
  read: (identity, source) => invoke("interactive_answer_read", { identity, source }),
  write: (identity, source, expectedRevision, values, reset) => invoke(reset ? "interactive_answer_reset" : "interactive_answer_write", { identity, source, expectedRevision, values }),
};
