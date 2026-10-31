using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// PDH owns counter timing and localization. Engines are kept separate.
public sealed class RemoteKitGpuCounters : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct Value { public uint Status; public double Double; }
    [StructLayout(LayoutKind.Sequential)] private struct Item { public IntPtr Name; public Value Value; }
    public sealed class Sample { public string Name; public double Percent; }
    public sealed class CpuSample { public int Pid; public double Seconds; }
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    public static CpuSample[] ReadCpu(int[] ids) {
        var output=new List<CpuSample>();
        foreach(int id in ids) {
            IntPtr process=OpenProcess(0x1000,false,id); if(process==IntPtr.Zero)continue;
            try {long creation,exit,kernel,user;if(GetProcessTimes(process,out creation,out exit,out kernel,out user))output.Add(new CpuSample{Pid=id,Seconds=(kernel+user)/10000000.0});}
            finally {CloseHandle(process);}
        }
        return output.ToArray();
    }
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] private static extern uint PdhOpenQueryW(string source, UIntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] private static extern uint PdhAddEnglishCounterW(IntPtr query, string path, UIntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll", CharSet=CharSet.Unicode)] private static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint bytes, out uint count, IntPtr items);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
    private IntPtr query, counter;
    private static void Check(uint result, string operation) { if(result!=0) throw new InvalidOperationException(operation+" PDH 0x"+result.ToString("x")); }
    public RemoteKitGpuCounters() {
        Check(PdhOpenQueryW(null,UIntPtr.Zero,out query),"OpenQuery");
        try { Check(PdhAddEnglishCounterW(query,@"\GPU Engine(*)\Utilization Percentage",UIntPtr.Zero,out counter),"AddEnglishCounter"); Check(PdhCollectQueryData(query),"CollectInitial"); }
        catch { Dispose(); throw; }
    }
    public Sample[] Read() {
        Check(PdhCollectQueryData(query),"Collect");
        uint bytes=0,count=0;
        uint result=PdhGetFormattedCounterArrayW(counter,0x200|0x8000,ref bytes,out count,IntPtr.Zero);
        if(result==0x800007D5 || bytes==0) return new Sample[0]; // No valid data yet.
        if(result!=0x800007D2 && result!=0) Check(result,"SizeArray");
        IntPtr buffer=Marshal.AllocHGlobal(checked((int)bytes));
        try {
            Check(PdhGetFormattedCounterArrayW(counter,0x200|0x8000,ref bytes,out count,buffer),"ReadArray");
            int size=Marshal.SizeOf(typeof(Item));var output=new List<Sample>();
            for(int i=0;i<count;i++) {
                Item item=(Item)Marshal.PtrToStructure(IntPtr.Add(buffer,i*size),typeof(Item));
                if(item.Value.Status<=1 && !Double.IsNaN(item.Value.Double))output.Add(new Sample{Name=Marshal.PtrToStringUni(item.Name),Percent=item.Value.Double});
            }
            return output.ToArray();
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    public void Dispose(){if(query!=IntPtr.Zero){PdhCloseQuery(query);query=IntPtr.Zero;}}
}
