import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Pencil, ThumbsDown, ThumbsUp } from "lucide-react";

export type PageFeedbackValue = "helpful" | "not-helpful";

export interface PageActionsProps {
  editLink?: string;
  copyHref?: string;
  showCopy?: boolean;
  showFeedback?: boolean;
  onFeedback?: (value: PageFeedbackValue) => void;
}

export function PageActions({
  editLink,
  copyHref,
  showCopy = true,
  showFeedback = false,
  onFeedback,
}: PageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<PageFeedbackValue>();
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  const copyPageLink = async () => {
    const href = copyHref ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(href);
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const submitFeedback = (value: PageFeedbackValue) => {
    setFeedback(value);
    onFeedback?.(value);
  };

  if (!showCopy && !editLink && !showFeedback) return null;

  return (
    <div className="docsfn-page-actions" aria-label="Page actions">
      <div className="docsfn-page-actions-links">
        {showCopy ? (
          <button type="button" onClick={copyPageLink}>
            {copied ? <Check size={15} strokeWidth={1.8} /> : <Copy size={15} strokeWidth={1.8} />}
            {copied ? "Copied" : "Copy link"}
          </button>
        ) : null}
        {editLink ? (
          <a href={editLink} target="_blank" rel="noreferrer noopener">
            <Pencil size={15} strokeWidth={1.8} /> Edit page
          </a>
        ) : null}
      </div>
      {showFeedback ? (
        <div className="docsfn-page-feedback">
          <span>{feedback ? "Thanks for the feedback" : "Was this helpful?"}</span>
          {!feedback ? (
            <>
              <button type="button" aria-label="This page was helpful" onClick={() => submitFeedback("helpful")}>
                <ThumbsUp size={15} strokeWidth={1.8} />
              </button>
              <button type="button" aria-label="This page was not helpful" onClick={() => submitFeedback("not-helpful")}>
                <ThumbsDown size={15} strokeWidth={1.8} />
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
