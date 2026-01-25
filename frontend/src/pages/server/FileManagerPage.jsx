import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Editor } from '@monaco-editor/react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  File,
  Folder,
  ArrowLeft,
  Plus,
  Trash2,
  Edit2,
  Download,
  RefreshCcw,
  ChevronRight,
  UploadCloud,
  FilePlus,
  FileJson,
  FileText,
  Binary,
  FileCode,
  Info,
  Save,
  Loader2,
  Ellipsis,
  Archive,
  AlertTriangle,
  CheckCircle2,
  X,
  LayoutGrid,
  List as ListIcon,
  Search,
  MoreVertical,
  FileImage,
  FileAudio,
  FileVideo
} from 'lucide-react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Utility functions
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
};

const formatDate = (dateString) => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
};

const getFileLanguage = (filename) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const languageMap = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', java: 'java', json: 'json', xml: 'xml', html: 'html',
    css: 'css', md: 'markdown', yml: 'yaml', yaml: 'yaml', sh: 'shell',
    bash: 'shell', txt: 'plaintext', properties: 'properties', ini: 'ini',
    sql: 'sql', php: 'php', rb: 'ruby', rs: 'rust', go: 'go',
    c: 'c', cpp: 'cpp', cs: 'csharp'
  };
  return languageMap[ext] || 'plaintext';
};

const getFileIcon = (file, className = "h-4 w-4") => {
  if (!file?.is_file) return <Folder className={`${className} text-blue-500 fill-blue-500/20`} />;

  const ext = file.name.split('.').pop()?.toLowerCase();
  const codeExts = ['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'php', 'rb', 'go', 'rs', 'c', 'cpp', 'cs', 'html', 'css'];
  const archiveExts = ['zip', 'tar', 'gz', 'rar', '7z'];
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
  const audioExts = ['mp3', 'wav', 'ogg'];
  const videoExts = ['mp4', 'webm', 'mkv'];

  if (codeExts.includes(ext)) return <FileCode className={`${className} text-violet-500`} />;
  if (archiveExts.includes(ext)) return <Archive className={`${className} text-yellow-500`} />;
  if (imageExts.includes(ext)) return <FileImage className={`${className} text-pink-500`} />;
  if (audioExts.includes(ext)) return <FileAudio className={`${className} text-cyan-500`} />;
  if (videoExts.includes(ext)) return <FileVideo className={`${className} text-red-500`} />;
  if (file.mimetype?.includes('json')) return <FileJson className={`${className} text-green-500`} />;
  if (file.mimetype?.includes('text')) return <FileText className={`${className} text-orange-500`} />;
  if (['jar', 'exe', 'bin', 'dll'].includes(ext)) return <Binary className={`${className} text-purple-500`} />;

  return <File className={`${className} text-gray-500`} />;
};

const FileManagerPage = () => {
  const { id } = useParams();

  // Core state
  const [files, setFiles] = useState([]);
  const [currentPath, setCurrentPath] = useState('/');
  const [breadcrumbs, setBreadcrumbs] = useState(['/']);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // UI State
  const [viewMode, setViewMode] = useState('list'); // 'list' | 'grid'
  const [searchQuery, setSearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Selection state
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);

  // Dialog states
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newItemType, setNewItemType] = useState(null);
  const [newItemName, setNewItemName] = useState('');
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameData, setRenameData] = useState({ oldName: '', newName: '' });
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);

  // Editor states
  const [editorContent, setEditorContent] = useState('');
  const [editorLanguage, setEditorLanguage] = useState('plaintext');
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Path handling
  const normalizePath = useCallback((path) => {
    path = path.replace(/\/+/g, '/');
    return path.endsWith('/') ? path : `${path}/`;
  }, []);

  const joinPaths = useCallback((...paths) => {
    return normalizePath(paths.join('/'));
  }, [normalizePath]);

  // Error handling
  const handleError = useCallback((error, customMessage = null) => {
    console.error('Operation failed:', error);
    const message = customMessage || error?.response?.data?.error || error.message || 'Operation failed';
    setError(message);
    toast({
      variant: "destructive",
      title: "Error",
      description: message,
      duration: 5000,
    });
  }, []);

  // Success handling
  const handleSuccess = useCallback((message) => {
    toast({
      title: "Success",
      description: message,
      duration: 3000,
    });
  }, []);

  // File operations
  const fetchFiles = useCallback(async (directory = '/') => {
    setIsLoading(true);
    setError(null);
    try {
      const normalizedPath = normalizePath(directory);
      const response = await fetch(`/api/server/${id}/files/list?directory=${encodeURIComponent(normalizedPath)}`);

      if (!response.ok) throw new Error(`Failed to fetch files: ${response.statusText}`);

      const data = await response.json();

      if (data.object === 'list') {
        // Sort: Folders first, then files. Alphabetical within groups.
        const sortedFiles = data.data.map(item => item.attributes).sort((a, b) => {
          if (a.is_file === b.is_file) {
            return a.name.localeCompare(b.name);
          }
          return a.is_file ? 1 : -1;
        });
        
        setFiles(sortedFiles);
        setCurrentPath(normalizedPath);

        const newBreadcrumbs = normalizedPath === '/'
          ? ['/']
          : ['/', ...normalizedPath.split('/').filter(Boolean)];
        setBreadcrumbs(newBreadcrumbs);
      } else {
        throw new Error('Invalid response format');
      }
    } catch (err) {
      handleError(err, 'Failed to fetch files');
    } finally {
      setIsLoading(false);
    }
  }, [id, normalizePath, handleError]);

  const handleFileView = useCallback(async (file) => {
    try {
      setIsLoading(true);
      const filePath = joinPaths(currentPath, file.name);
      const response = await fetch(`/api/server/${id}/files/contents?file=${encodeURIComponent(filePath)}`);

      if (!response.ok) throw new Error(`Failed to fetch file contents: ${response.statusText}`);

      const content = await response.text();
      setEditorLanguage(getFileLanguage(file.name));
      setEditorContent(content);
      setSelectedFile(file);
      setIsEditorDirty(false);
    } catch (err) {
      handleError(err, 'Failed to view file contents');
    } finally {
      setIsLoading(false);
    }
  }, [id, currentPath, joinPaths, handleError]);

  const handleFileSave = async () => {
    if (!selectedFile) return;

    try {
      setIsSaving(true);
      const filePath = joinPaths(currentPath, selectedFile.name);
      const response = await fetch(`/api/server/${id}/files/write?file=${encodeURIComponent(filePath)}`, {
        method: 'POST',
        body: editorContent
      });

      if (!response.ok) throw new Error(`Failed to save file: ${response.statusText}`);

      handleSuccess('File saved successfully');
      setIsEditorDirty(false);
    } catch (err) {
      handleError(err, 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  };

  const handleNewItem = async () => {
    if (!newItemName.trim()) {
      handleError(new Error('Name cannot be empty'));
      return;
    }

    try {
      const normalizedPath = normalizePath(currentPath);

      if (newItemType === 'folder') {
        const response = await fetch(`/api/server/${id}/files/create-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: normalizedPath, name: newItemName })
        });

        if (!response.ok) throw new Error(`Failed to create folder: ${response.statusText}`);
      } else {
        const filePath = joinPaths(currentPath, newItemName);
        const response = await fetch(`/api/server/${id}/files/write?file=${encodeURIComponent(filePath)}`, {
          method: 'POST',
          body: ' '
        });

        if (!response.ok) throw new Error(`Failed to create file: ${response.statusText}`);
      }

      handleSuccess(`${newItemType === 'folder' ? 'Folder' : 'File'} created successfully`);
      fetchFiles(normalizedPath);
      setShowNewDialog(false);
      setNewItemName('');
      setNewItemType(null);
    } catch (err) {
      handleError(err, `Failed to create ${newItemType}`);
    }
  };

  const handleFileRename = async () => {
    if (!renameData.newName.trim()) {
      handleError(new Error('New name cannot be empty'));
      return;
    }

    try {
      const normalizedPath = normalizePath(currentPath);
      const response = await fetch(`/api/server/${id}/files/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root: normalizedPath,
          files: [{ from: renameData.oldName, to: renameData.newName }]
        })
      });

      if (!response.ok) throw new Error(`Failed to rename file: ${response.statusText}`);

      handleSuccess('File renamed successfully');
      fetchFiles(normalizedPath);
      setShowRenameDialog(false);
      setRenameData({ oldName: '', newName: '' });
    } catch (err) {
      handleError(err, 'Failed to rename file');
    }
  };

  const handleFileDelete = async (files) => {
    const fileList = Array.isArray(files) ? files : [files];

    try {
      const normalizedPath = normalizePath(currentPath);
      const response = await fetch(`/api/server/${id}/files/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: normalizedPath, files: fileList })
      });

      if (!response.ok) throw new Error(`Failed to delete files: ${response.statusText}`);

      handleSuccess(fileList.length > 1 ? `${fileList.length} files deleted` : 'File deleted successfully');
      fetchFiles(normalizedPath);
      setSelectedFiles([]);
    } catch (err) {
      handleError(err, 'Failed to delete file(s)');
    }
  };

  const handleArchive = async (files) => {
    const fileList = Array.isArray(files) ? files : [files];

    try {
      const normalizedPath = normalizePath(currentPath);
      const response = await fetch(`/api/server/${id}/files/compress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: normalizedPath, files: fileList })
      });

      if (!response.ok) throw new Error(`Failed to create archive: ${response.statusText}`);

      handleSuccess('Files archived successfully');
      fetchFiles(normalizedPath);
      setShowArchiveDialog(false);
      setSelectedFiles([]);
    } catch (err) {
      handleError(err, 'Failed to archive files');
    }
  };

  const handleUnarchive = async (file) => {
    try {
      const normalizedPath = normalizePath(currentPath);
      const response = await fetch(`/api/server/${id}/files/decompress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: normalizedPath, file: file.name })
      });

      if (!response.ok) throw new Error(`Failed to unarchive file: ${response.statusText}`);

      handleSuccess('File unarchived successfully');
      fetchFiles(normalizedPath);
    } catch (err) {
      handleError(err, 'Failed to unarchive file');
    }
  };

  const downloadFile = async (file) => {
    try {
      const normalizedPath = normalizePath(currentPath);
      const filePath = joinPaths(normalizedPath, file.name);

      const response = await fetch(`/api/server/${id}/files/download?file=${encodeURIComponent(filePath)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
      });

      if (!response.ok) throw new Error(`Failed to get download URL: ${response.statusText}`);

      const data = await response.json();

      if (data.object === 'signed_url') {
        const link = document.createElement('a');
        link.href = data.attributes.url;
        link.download = file.name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        handleSuccess('Download started');
      } else {
        throw new Error('Invalid download URL response');
      }
    } catch (err) {
      handleError(err, 'Failed to download file');
    }
  };

  const handleFileUpload = async (filesToUpload) => {
    const files = Array.isArray(filesToUpload) ? filesToUpload : Array.from(filesToUpload);
    if (files.length === 0) return;

    try {
      setUploadProgress(0);
      setShowUploadDialog(true); // Show dialog to show progress
      const normalizedPath = normalizePath(currentPath);

      const uploadUrlResponse = await fetch(`/api/server/${id}/files/upload`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
      });

      if (!uploadUrlResponse.ok) throw new Error(`Failed to get upload URL: ${uploadUrlResponse.statusText}`);

      const uploadUrlData = await uploadUrlResponse.json();

      if (uploadUrlData.object !== 'signed_url') throw new Error('Invalid upload URL response');

      const uploadUrl = new URL(uploadUrlData.attributes.url);
      uploadUrl.searchParams.append('directory', normalizedPath);

      const formData = new FormData();
      files.forEach(file => formData.append('files', file));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', uploadUrl.toString());

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(progress);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          handleSuccess(`${files.length} file(s) uploaded successfully`);
          fetchFiles(normalizedPath);
          setShowUploadDialog(false);
          setUploadProgress(0);
        } else {
          handleError(new Error(`Upload failed with status: ${xhr.status}`));
          setShowUploadDialog(false);
        }
      };

      xhr.onerror = () => {
        handleError(new Error('Upload failed'));
        setShowUploadDialog(false);
      };

      xhr.send(formData);
    } catch (err) {
      handleError(err, 'Failed to upload file(s)');
      setUploadProgress(0);
      setShowUploadDialog(false);
    }
  };

  // Navigation
  const handleNavigateToPath = useCallback((path) => {
    if (isEditorDirty) {
      if (window.confirm('You have unsaved changes. Are you sure you want to navigate away?')) {
        setSelectedFile(null);
        setEditorContent('');
        setIsEditorDirty(false);
        fetchFiles(path);
      }
    } else {
      fetchFiles(path);
    }
  }, [isEditorDirty, fetchFiles]);

  const handleNavigateUp = useCallback(() => {
    if (currentPath === '/') return;
    const parentPath = currentPath.split('/').slice(0, -2).join('/') || '/';
    handleNavigateToPath(parentPath);
  }, [currentPath, handleNavigateToPath]);

  // Initial load
  useEffect(() => {
    fetchFiles();
  }, [fetchFiles]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && selectedFile) {
        e.preventDefault();
        handleFileSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedFile, handleFileSave]);

  // Filtered files
  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    return files.filter(file => 
      file.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [files, searchQuery]);

  // Drag and Drop Handlers
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDragging(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileUpload(files);
    }
  }, [handleFileUpload]);

  // Render Helpers
  const renderFileActions = (file) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        {file.is_file && (
          <>
            <DropdownMenuItem onClick={() => handleFileView(file)}>
              <FileText className="mr-2 h-4 w-4" /> View/Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => downloadFile(file)}>
              <Download className="mr-2 h-4 w-4" /> Download
            </DropdownMenuItem>
            {file.name.match(/\.(zip|tar|gz|rar|7z)$/i) ? (
              <DropdownMenuItem onClick={() => handleUnarchive(file)}>
                <Archive className="mr-2 h-4 w-4" /> Extract
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => handleArchive(file.name)}>
                <Archive className="mr-2 h-4 w-4" /> Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => {
          setRenameData({ oldName: file.name, newName: file.name });
          setShowRenameDialog(true);
        }}>
          <Edit2 className="mr-2 h-4 w-4" /> Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => handleFileDelete(file.name)}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div 
      className="min-h-screen p-4 md:p-6 flex flex-col space-y-6 relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drag Overlay */}
      <AnimatePresence>
        {isDragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg flex flex-col items-center justify-center pointer-events-none"
          >
            <UploadCloud className="h-24 w-24 text-primary animate-bounce" />
            <h2 className="text-2xl font-bold mt-4">Drop files to upload</h2>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header Section */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight">File Manager</h1>
          <div className="flex items-center flex-wrap gap-1 text-sm text-muted-foreground">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => handleNavigateToPath('/')}
            >
              root
            </Button>
            {breadcrumbs.slice(1).map((crumb, index) => (
              <React.Fragment key={index}>
                <ChevronRight className="h-3 w-3" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2"
                  onClick={() => {
                    const path = breadcrumbs.slice(0, index + 2).join('');
                    handleNavigateToPath(path);
                  }}
                >
                  {crumb}
                </Button>
              </React.Fragment>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-full md:w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search files..."
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          
          <div className="flex items-center border rounded-md bg-background">
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('list')}
              className="rounded-r-none"
            >
              <ListIcon className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="icon"
              onClick={() => setViewMode('grid')}
              className="rounded-l-none"
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" /> New
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => { setNewItemType('file'); setShowNewDialog(true); }}>
                <FilePlus className="mr-2 h-4 w-4" /> New File
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setNewItemType('folder'); setShowNewDialog(true); }}>
                <Folder className="mr-2 h-4 w-4" /> New Folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" onClick={() => setShowUploadDialog(true)}>
            <UploadCloud className="mr-2 h-4 w-4" /> Upload
          </Button>

          <Button variant="outline" size="icon" onClick={() => fetchFiles(currentPath)} disabled={isLoading}>
            <RefreshCcw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Main Content Area */}
      <Card className="flex-1 flex flex-col min-h-0">
        <CardContent className="p-0 flex-1 flex flex-col min-h-0">
          <ScrollArea className="flex-1 h-full">
            <AnimatePresence mode="wait">
              {viewMode === 'list' ? (
                <motion.div
                  key="list"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2 }}
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            checked={files.length > 0 && selectedFiles.length === files.length}
                            onCheckedChange={(checked) => {
                              setSelectedFiles(checked ? files.map(f => f.name) : []);
                            }}
                          />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead className="hidden md:table-cell">Size</TableHead>
                        <TableHead className="hidden md:table-cell">Modified</TableHead>
                        <TableHead className="hidden lg:table-cell">Permissions</TableHead>
                        <TableHead className="w-[50px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredFiles.map((file) => (
                        <TableRow
                          key={file.name}
                          className={`group ${selectedFiles.includes(file.name) ? 'bg-accent/50' : ''}`}
                        >
                          <TableCell>
                            <Checkbox
                              checked={selectedFiles.includes(file.name)}
                              onCheckedChange={(checked) => {
                                setSelectedFiles(checked
                                  ? [...selectedFiles, file.name]
                                  : selectedFiles.filter(f => f !== file.name)
                                );
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <div
                              className="flex items-center space-x-3 cursor-pointer select-none"
                              onClick={() => {
                                if (file.is_file) handleFileView(file);
                                else handleNavigateToPath(joinPaths(currentPath, file.name));
                              }}
                            >
                              {getFileIcon(file)}
                              <span className="font-medium group-hover:text-primary transition-colors">
                                {file.name}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground">{formatBytes(file.size)}</TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground">{formatDate(file.modified_at)}</TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                              {file.mode}
                            </code>
                          </TableCell>
                          <TableCell>
                            {renderFileActions(file)}
                          </TableCell>
                        </TableRow>
                      ))}
                      {filteredFiles.length === 0 && !isLoading && (
                        <TableRow>
                          <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                            {searchQuery ? 'No matching files found' : 'This folder is empty'}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </motion.div>
              ) : (
                <motion.div
                  key="grid"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                  className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4"
                >
                  {filteredFiles.map((file) => (
                    <Card
                      key={file.name}
                      className={`
                        group cursor-pointer transition-all hover:shadow-md hover:border-primary/50
                        ${selectedFiles.includes(file.name) ? 'border-primary bg-accent/10' : ''}
                      `}
                      onClick={() => {
                        if (file.is_file) handleFileView(file);
                        else handleNavigateToPath(joinPaths(currentPath, file.name));
                      }}
                    >
                      <CardContent className="p-4 flex flex-col items-center text-center gap-3">
                        <div className="w-full flex justify-between items-start">
                          <Checkbox
                            checked={selectedFiles.includes(file.name)}
                            onCheckedChange={(checked) => {
                              setSelectedFiles(checked
                                ? [...selectedFiles, file.name]
                                : selectedFiles.filter(f => f !== file.name)
                              );
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                          <div onClick={(e) => e.stopPropagation()}>
                            {renderFileActions(file)}
                          </div>
                        </div>
                        <div className="p-2 rounded-full bg-accent/50 group-hover:bg-accent transition-colors">
                          {getFileIcon(file, "h-8 w-8")}
                        </div>
                        <div className="space-y-1 w-full">
                          <p className="font-medium text-sm truncate w-full" title={file.name}>
                            {file.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatBytes(file.size)}
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                  {filteredFiles.length === 0 && !isLoading && (
                    <div className="col-span-full h-32 flex items-center justify-center text-muted-foreground">
                      {searchQuery ? 'No matching files found' : 'This folder is empty'}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Bulk Actions Floating Bar */}
      <AnimatePresence>
        {selectedFiles.length > 0 && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-40"
          >
            <Card className="shadow-xl border-primary/20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <CardContent className="flex items-center gap-4 p-3">
                <span className="text-sm font-medium px-2">
                  {selectedFiles.length} selected
                </span>
                <div className="h-4 w-px bg-border" />
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleArchive(selectedFiles)}
                  >
                    <Archive className="h-4 w-4 mr-2" />
                    Archive
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      if (window.confirm(`Are you sure you want to delete ${selectedFiles.length} file(s)?`)) {
                        handleFileDelete(selectedFiles);
                      }
                    }}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelectedFiles([])}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dialogs */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New {newItemType === 'folder' ? 'Folder' : 'File'}</DialogTitle>
            <DialogDescription>Enter a name for the new {newItemType}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder={newItemType === 'folder' ? 'New Folder' : 'file.txt'}
                onKeyDown={(e) => e.key === 'Enter' && handleNewItem()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewDialog(false)}>Cancel</Button>
            <Button onClick={handleNewItem} disabled={!newItemName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
            <DialogDescription>Drag and drop or select file(s) to upload</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div
              className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:border-primary transition-colors relative"
              onClick={() => document.getElementById('file-upload-dialog').click()}
            >
              <UploadCloud className="h-12 w-12 mx-auto text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">Click to browse</p>
              <input
                id="file-upload-dialog"
                type="file"
                className="hidden"
                multiple
                onChange={(e) => handleFileUpload(e.target.files)}
              />
            </div>
            {uploadProgress > 0 && (
              <div className="space-y-2">
                <Progress value={uploadProgress} className="w-full" />
                <p className="text-sm text-center text-muted-foreground">{uploadProgress}% uploaded</p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Item</DialogTitle>
            <DialogDescription>Enter a new name for the item</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="newName">New name</Label>
              <Input
                id="newName"
                value={renameData.newName}
                onChange={(e) => setRenameData({ ...renameData, newName: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && handleFileRename()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)}>Cancel</Button>
            <Button onClick={handleFileRename} disabled={!renameData.newName.trim()}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showArchiveDialog} onOpenChange={setShowArchiveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Archive</DialogTitle>
            <DialogDescription>{selectedFiles.length} file(s) will be archived</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowArchiveDialog(false)}>Cancel</Button>
            <Button onClick={handleArchive}>Create Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editor Dialog */}
      <Dialog
        open={selectedFile !== null}
        onOpenChange={(open) => {
          if (!open && isEditorDirty) {
            if (window.confirm('You have unsaved changes. Close anyway?')) {
              setSelectedFile(null);
              setEditorContent('');
              setIsEditorDirty(false);
            }
          } else if (!open) {
            setSelectedFile(null);
            setEditorContent('');
          }
        }}
      >
        <DialogContent className="max-w-6xl h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b bg-muted/30">
            <div className="flex items-center space-x-2">
              {getFileIcon(selectedFile || {})}
              <span className="font-medium">{selectedFile?.name}</span>
              {isEditorDirty && <span className="text-xs text-yellow-500 font-medium px-2 py-0.5 bg-yellow-500/10 rounded-full">Unsaved</span>}
            </div>
            <div className="flex items-center space-x-2">
              <Button
                variant={isEditorDirty ? "default" : "outline"}
                size="sm"
                onClick={handleFileSave}
                disabled={!isEditorDirty || isSaving}
              >
                {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
                Save
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSelectedFile(null)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              language={editorLanguage}
              value={editorContent}
              onChange={(value) => {
                setEditorContent(value || '');
                setIsEditorDirty(true);
              }}
              theme="vs-dark"
              options={{
                minimap: { enabled: true },
                fontSize: 14,
                lineNumbers: 'on',
                wordWrap: 'on',
                automaticLayout: true,
                padding: { top: 16, bottom: 16 },
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontLigatures: true,
              }}
              loading={<div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin" /></div>}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Loading Overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-background/50 backdrop-blur-[2px] flex items-center justify-center z-50 pointer-events-none">
          <div className="flex items-center gap-3 bg-background border p-4 rounded-lg shadow-lg">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm font-medium">Loading...</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default FileManagerPage;
