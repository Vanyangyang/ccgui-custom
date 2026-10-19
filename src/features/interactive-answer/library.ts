import { createLibrary } from "@openuidev/react-lang";
import { answerComponents } from "./components";

export const answerLibrary = createLibrary({
  id: "ccgui-interactive-answer-v1",
  root: "Stack",
  components: answerComponents,
});
