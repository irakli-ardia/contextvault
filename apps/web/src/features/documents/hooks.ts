import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HttpError } from "../../lib/http-client";
import { deleteDocument, retryDocument } from "./api";
import { documentsKey, documentsQueryOptions } from "./queries";
import { checkUpload, uploadDocument } from "./upload";

export const useDocuments = (workspaceId: string) => useQuery(documentsQueryOptions(workspaceId));

export function useUpload(workspaceId: string) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState(0);
  const mutation = useMutation({
    mutationFn: async (file: File) => {
      const check = checkUpload(file);
      if (!check.ok) throw new HttpError(0, check.code);
      setProgress(0);
      await uploadDocument(workspaceId, file, check.contentType, setProgress);
    },
    // Success or not, the server may have created a row: always refresh.
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey(workspaceId) }),
  });
  return { ...mutation, progress };
}

export function useRetry(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => retryDocument(workspaceId, documentId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey(workspaceId) }),
  });
}

export function useDelete(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (documentId: string) => deleteDocument(workspaceId, documentId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: documentsKey(workspaceId) }),
  });
}
