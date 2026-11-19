import { MessageCircleQuestionIcon } from "lucide-react";
import type { SessionDecision } from "talos-shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// A question the session asked while working. Each choice sends itself as the
// next message; the message box below answers in the person's own words.
export const DecisionCard = ({ decision, onChoose }: { decision: SessionDecision; onChoose: (choice: string) => void }) => (
  <Card className="py-4">
    <CardContent className="flex flex-col gap-3 px-4">
      <div className="flex items-start gap-2">
        <MessageCircleQuestionIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Decision" />
        <p className="text-sm break-words">{decision.question}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {decision.choices.map((choice, index) => (
          <Button key={`${index}:${choice}`} variant="outline" size="sm" onClick={() => onChoose(choice)}>
            {choice}
          </Button>
        ))}
      </div>
    </CardContent>
  </Card>
);
