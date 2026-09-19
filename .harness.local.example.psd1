@{
  # Keep machine paths here, never API keys. Copy this file to
  # .harness.local.psd1; the local file is ignored by Git.
  NodePath = 'C:\path\to\node.exe'
  EnvFile = '.env'
  CuaBinary = '.tools\cua-driver\0.22.2\bin\cua-driver.exe'
  CuaSocket = '\\.\pipe\computer-harness-local'
  Model = 'glm-5.3-flash'
  Preset = 'assisted'
  OutputRoot = 'runs\local'

  # Required only when selecting hybrid Memory retrieval.
  MemoryEmbeddingEndpoint = ''
}
