import { MessageCircleQuestionIcon } from "lucide-react";
import { useId } from "react";
import type { SessionDecision } from "talos-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// A question the session asked while working. A choice answers it by its
// position; the message box below answers in the person's own words.
export const DecisionCard = ({ decision, onChoose }: { decision: SessionDecision; onChoose: (choice: number) => void }) => {
  const questionId = useId();
  return (
    <Card className="py-4" role="group" aria-labelledby={questionId}>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start gap-2">
          <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" role="img" aria-label="Decision" />
          <p id={questionId} className="text-sm break-words">
            {decision.question}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {decision.choices.map((choice, index) => (
            <Button
              key={`${index}:${choice}`}
              variant="outline"
              size="sm"
              className="h-auto min-h-8 py-1.5 whitespace-normal text-left break-words"
              onClick={() => onChoose(index)}
            >
              {choice}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
