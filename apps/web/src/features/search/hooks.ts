import { useMutation } from "@tanstack/react-query";
import { searchModes } from "./api";
import type { ModeChoice } from "./model";
import { modesFor } from "./model";

export function useSearch(workspaceId: string) {
  return useMutation({
    mutationFn: ({ query, choice }: { query: string; choice: ModeChoice }) =>
      searchModes(workspaceId, query, modesFor(choice)),
  });
}
