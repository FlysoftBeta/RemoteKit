#include "browser/services_browser.h"

#include "base/no_destructor.h"
#include "third_party/blink/public/mojom/hid/hid.mojom.h"
#include "content/public/browser/usb_delegate.h"
#include "content/public/browser/usb_chooser.h"
#include "content/public/browser/hid_delegate.h"
#include "content/public/browser/serial_delegate.h"
#include "content/public/browser/bluetooth_delegate.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "services/device/public/mojom/hid.mojom.h"
#include "services/device/public/mojom/serial.mojom.h"
#include "services/device/public/mojom/usb_device.mojom.h"

namespace remotekit::browser {
namespace {
using content::BrowserContext;
using content::HidChooser;
using content::Page;
using content::RenderFrameHost;
using content::SerialChooser;
using content::UsbChooser;
class EmptyHidManager final : public device::mojom::HidManager {
 public:
  void GetDevicesAndSetClient(mojo::PendingAssociatedRemote<device::mojom::HidManagerClient>,
                              GetDevicesAndSetClientCallback callback) override {
    std::move(callback).Run({});
  }
  void GetDevices(GetDevicesCallback callback) override { std::move(callback).Run({}); }
  void Connect(const std::string&,
               mojo::PendingRemote<device::mojom::HidConnectionClient>,
               mojo::PendingRemote<device::mojom::HidConnectionWatcher>,
               bool,
               bool,
               ConnectCallback callback) override {
    std::move(callback).Run(mojo::NullRemote());
  }
  void AddReceiver(mojo::PendingReceiver<device::mojom::HidManager> receiver) override {
    receivers_.Add(this, std::move(receiver));
  }

 private:
  mojo::ReceiverSet<device::mojom::HidManager> receivers_;
};
class EmptyPortManager final : public device::mojom::SerialPortManager {
 public:
  void SetClient(mojo::PendingRemote<device::mojom::SerialPortManagerClient>) override {}
  void GetDevices(bool, GetDevicesCallback callback) override { std::move(callback).Run({}); }
  void OpenPort(const base::UnguessableToken&,
                bool,
                device::mojom::SerialConnectionOptionsPtr,
                mojo::PendingRemote<device::mojom::SerialPortClient>,
                mojo::PendingRemote<device::mojom::SerialPortConnectionWatcher>,
                OpenPortCallback callback) override {
    std::move(callback).Run(mojo::NullRemote());
  }
};
class EmptyUsbDelegate final : public content::UsbDelegate {
 public:
  void AdjustProtectedInterfaceClasses(BrowserContext* browser_context,
                                       const url::Origin& origin,
                                       RenderFrameHost* frame,
                                       std::vector<uint8_t>& classes) override {}
  std::unique_ptr<UsbChooser> RunChooser(
      RenderFrameHost& frame,
      blink::mojom::WebUsbRequestDeviceOptionsPtr options,
      blink::mojom::WebUsbService::GetPermissionCallback callback) override {
    std::move(callback).Run(nullptr);
    return nullptr;
  }
  bool PageMayUseUsb(Page& page) override { return true; }
  bool CanRequestDevicePermission(BrowserContext* browser_context,
                                  const url::Origin& origin) override {
    return true;
  }
  void RevokeDevicePermissionWebInitiated(BrowserContext* browser_context,
                                          const url::Origin& origin,
                                          const device::mojom::UsbDeviceInfo& device) override {}
  const device::mojom::UsbDeviceInfo* GetDeviceInfo(BrowserContext* browser_context,
                                                    const std::string& guid) override {
    return nullptr;
  }
  bool HasDevicePermission(BrowserContext* browser_context,
                           RenderFrameHost* frame,
                           const url::Origin& origin,
                           const device::mojom::UsbDeviceInfo& device_info) override {
    return false;
  }
  void GetDevices(BrowserContext* browser_context,
                  blink::mojom::WebUsbService::GetDevicesCallback callback) override {
    std::move(callback).Run({});
  }
  void GetDevice(BrowserContext* browser_context,
                 const std::string& guid,
                 base::span<const uint8_t> blocked_interface_classes,
                 mojo::PendingReceiver<device::mojom::UsbDevice> device_receiver,
                 mojo::PendingRemote<device::mojom::UsbDeviceClient> device_client) override {}
  void AddObserver(BrowserContext* browser_context, Observer* observer) override {}
  void RemoveObserver(BrowserContext* browser_context, Observer* observer) override {}
  bool IsServiceWorkerAllowedForOrigin(const url::Origin& origin) override { return false; }
  void IncrementConnectionCount(BrowserContext* browser_context,
                                const url::Origin& origin) override {}
  void DecrementConnectionCount(BrowserContext* browser_context,
                                const url::Origin& origin) override {}
};
class EmptyHidDelegate final : public content::HidDelegate {
 public:
  std::unique_ptr<HidChooser> RunChooser(
      RenderFrameHost* render_frame_host,
      std::vector<blink::mojom::HidDeviceFilterPtr> filters,
      std::vector<blink::mojom::HidDeviceFilterPtr> exclusion_filters,
      HidChooser::Callback callback) override {
    std::move(callback).Run({});
    return nullptr;
  }
  bool IsHidAllowedForFrame(RenderFrameHost* render_frame_host) override { return true; }
  bool CanRequestDevicePermission(BrowserContext* browser_context,
                                  const url::Origin& origin) override {
    return true;
  }
  bool HasDevicePermission(BrowserContext* browser_context,
                           RenderFrameHost* render_frame_host,
                           const url::Origin& origin,
                           const device::mojom::HidDeviceInfo& device) override {
    return false;
  }
  void RevokeDevicePermission(BrowserContext* browser_context,
                              RenderFrameHost* render_frame_host,
                              const url::Origin& origin,
                              const device::mojom::HidDeviceInfo& device) override {}
  device::mojom::HidManager* GetHidManager(BrowserContext* browser_context) override {
    return &manager_;
  }
  void AddObserver(BrowserContext* browser_context, Observer* observer) override {}
  void RemoveObserver(BrowserContext* browser_context, Observer* observer) override {}
  bool IsFidoAllowedForOrigin(BrowserContext* browser_context, const url::Origin& origin) override {
    return false;
  }
  bool IsServiceWorkerAllowedForOrigin(const url::Origin& origin) override { return false; }
  const device::mojom::HidDeviceInfo* GetDeviceInfo(BrowserContext* browser_context,
                                                    const std::string& guid) override {
    return nullptr;
  }
  void IncrementConnectionCount(BrowserContext* browser_context,
                                const url::Origin& origin) override {}
  void DecrementConnectionCount(BrowserContext* browser_context,
                                const url::Origin& origin) override {}

 private:
  EmptyHidManager manager_;
};
class EmptySerialDelegate final : public content::SerialDelegate {
 public:
  std::unique_ptr<SerialChooser> RunChooser(
      RenderFrameHost* frame,
      std::vector<blink::mojom::SerialPortFilterPtr> filters,
      std::vector<device::BluetoothUUID> allowed_bluetooth_service_class_ids,
      SerialChooser::Callback callback) override {
    std::move(callback).Run(nullptr);
    return nullptr;
  }
  bool CanRequestPortPermission(RenderFrameHost* frame) override { return true; }
  bool HasPortPermission(RenderFrameHost* frame,
                         const device::mojom::SerialPortInfo& port) override {
    return false;
  }
  void RevokePortPermissionWebInitiated(RenderFrameHost* frame,
                                        const base::UnguessableToken& token) override {}
  const device::mojom::SerialPortInfo* GetPortInfo(RenderFrameHost* frame,
                                                   const base::UnguessableToken& token) override {
    return nullptr;
  }
  device::mojom::SerialPortManager* GetPortManager(RenderFrameHost* frame) override {
    return &manager_;
  }
  void AddObserver(RenderFrameHost* frame, Observer* observer) override {}
  void RemoveObserver(RenderFrameHost* frame, Observer* observer) override {}

 private:
  EmptyPortManager manager_;
};
}  // namespace
content::UsbDelegate* ServicesBrowserClient::GetUsbDelegate() {
  static base::NoDestructor<EmptyUsbDelegate> delegate;
  return delegate.get();
}
content::HidDelegate* ServicesBrowserClient::GetHidDelegate() {
  static base::NoDestructor<EmptyHidDelegate> delegate;
  return delegate.get();
}
content::SerialDelegate* ServicesBrowserClient::GetSerialDelegate() {
  static base::NoDestructor<EmptySerialDelegate> delegate;
  return delegate.get();
}
content::BluetoothDelegate* ServicesBrowserClient::GetBluetoothDelegate() {
  static base::NoDestructor<content::BluetoothDelegate> delegate;
  return delegate.get();
}
}  // namespace remotekit::browser
