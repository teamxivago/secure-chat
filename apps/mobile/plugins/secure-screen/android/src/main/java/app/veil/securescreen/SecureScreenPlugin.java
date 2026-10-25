package app.veil.securescreen;

import android.app.Activity;
import android.os.Build;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Screenshot / screen-recording protection.
 *
 * FLAG_SECURE makes the system render the window as black in screenshots, screen recordings,
 * casting and the recent-apps thumbnail. On Android 14+ a ScreenCaptureCallback additionally
 * reports screenshot attempts so the app can notify the chat.
 */
@CapacitorPlugin(name = "SecureScreen")
public class SecureScreenPlugin extends Plugin {

    private Object captureCallback;

    @Override
    public void load() {
        // Protect from the very first frame (before JS calls enable()).
        getActivity().runOnUiThread(this::applyFlag);
        registerCaptureCallback();
    }

    private void applyFlag() {
        getActivity().getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
    }

    @PluginMethod
    public void enable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            applyFlag();
            call.resolve();
        });
    }

    @PluginMethod
    public void disable(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    @PluginMethod
    public void isCaptured(PluginCall call) {
        // With FLAG_SECURE, recordings only ever contain a black surface.
        JSObject ret = new JSObject();
        ret.put("captured", false);
        call.resolve(ret);
    }

    private void registerCaptureCallback() {
        if (Build.VERSION.SDK_INT < 34) return;
        Activity activity = getActivity();
        Activity.ScreenCaptureCallback cb = () -> notifyListeners("screenshotTaken", new JSObject());
        activity.registerScreenCaptureCallback(activity.getMainExecutor(), cb);
        captureCallback = cb;
    }

    @Override
    protected void handleOnDestroy() {
        if (Build.VERSION.SDK_INT >= 34 && captureCallback != null) {
            getActivity().unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) captureCallback);
        }
        super.handleOnDestroy();
    }
}
