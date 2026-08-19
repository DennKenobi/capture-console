{
  "variables": {
    "ndi_dir": "<(module_root_dir)/../../node_modules/@stagetimerio/grandiose/ndi"
  },
  "targets": [
    {
      "target_name": "ndi_texture_send",
      "sources": [ "src/addon.cc" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(ndi_dir)/include"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "conditions": [
        ["OS=='win'", {
          "link_settings": {
            "libraries": [ "Processing.NDI.Lib.x64.lib", "d3d11.lib", "dxgi.lib" ],
            "library_dirs": [ "<(ndi_dir)/lib/win-x64" ]
          },
          "copies": [{
            "destination": "<(module_root_dir)/build/Release/",
            "files": [ "<(ndi_dir)/lib/win-x64/Processing.NDI.Lib.x64.dll" ]
          }],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 1 }
          }
        }]
      ]
    }
  ]
}
