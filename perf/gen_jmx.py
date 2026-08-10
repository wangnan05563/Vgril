#!/usr/bin/env python3
# gen_jmx.py - 生成 JMeter 测试计划(JMX) 到本目录。
# 运行: python gen_jmx.py
import os

HOST = "127.0.0.1"
PORT = 8088

SAVE_CONFIG = """<value class="SampleSaveConfiguration">
  <xml>false</xml>
  <fieldNames>true</fieldNames>
  <time>true</time>
  <timestamp>true</timestamp>
  <latency>true</latency>
  <connectTime>true</connectTime>
  <success>true</success>
  <label>true</label>
  <code>true</code>
  <message>true</message>
  <threadName>true</threadName>
  <dataType>true</dataType>
  <encoding>false</encoding>
  <assertions>true</assertions>
  <subresults>true</subresults>
  <responseData>false</responseData>
  <samplerData>false</samplerData>
  <responseHeaders>false</responseHeaders>
  <requestHeaders>false</requestHeaders>
  <responseDataOnError>false</responseDataOnError>
  <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
  <assertionsResultsToSave>0</assertionsResultsToSave>
  <bytes>true</bytes>
  <sentBytes>true</sentBytes>
  <url>true</url>
  <threadCounts>true</threadCounts>
  <idleTime>true</idleTime>
  <hostname>false</hostname>
  <activeThreadCounts>false</activeThreadCounts>
</value>"""

LISTENER = """<ResultCollector guiclass="{gui}" testclass="ResultCollector" testname="{name}" enabled="true">
  <boolProp name="ResultCollector.error_logging">false</boolProp>
  <stringProp name="filename"></stringProp>
  <longProp name="count">0</longProp>
</ResultCollector>
<hashTree/>"""


def xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def get_sampler(label, path, method="GET", body=None, expect="200"):
    if method == "POST" and body is not None:
        body_xml = """<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
      <collectionProp name="Arguments.arguments">
        <elementProp name="body" elementType="HTTPArgument">
          <boolProp name="HTTPArgument.always_encode">false</boolProp>
          <stringProp name="Argument.value">{body}</stringProp>
          <stringProp name="Argument.metadata">=</stringProp>
        </elementProp>
      </collectionProp>
    </elementProp>""".format(body=xml_escape(body))
        post_raw = "<boolProp name=\"HTTPSampler.postBodyRaw\">true</boolProp>"
        header = """<HeaderManager guiclass="HeaderPanel" testclass="HeaderManager" testname="HTTP Header Manager" enabled="true">
      <collectionProp name="HeaderManager.headers">
        <elementProp name="" elementType="Header">
          <stringProp name="Header.name">Content-Type</stringProp>
          <stringProp name="Header.value">application/json</stringProp>
        </elementProp>
      </collectionProp>
    </HeaderManager>
    <hashTree/>"""
    else:
        body_xml = """<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
      <collectionProp name="Arguments.arguments"/>
    </elementProp>"""
        post_raw = "<boolProp name=\"HTTPSampler.postBodyRaw\">false</boolProp>"
        header = ""

    sampler = """<HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="{label}" enabled="true">
  {body_xml}
  <stringProp name="HTTPSampler.domain"></stringProp>
  <stringProp name="HTTPSampler.port"></stringProp>
  <stringProp name="HTTPSampler.protocol"></stringProp>
  <stringProp name="HTTPSampler.path">{path}</stringProp>
  <stringProp name="HTTPSampler.method">{method}</stringProp>
  <stringProp name="HTTPSampler.contentEncoding"></stringProp>
  <boolProp name="HTTPSampler.follow_redirects">true</boolProp>
  <boolProp name="HTTPSampler.auto_redirects">false</boolProp>
  <boolProp name="HTTPSampler.use_keepalive">true</boolProp>
  {post_raw}
</HTTPSamplerProxy>
<hashTree>
  {header}<ResponseAssertion guiclass="AssertionGui" testclass="ResponseAssertion" testname="Assert {label}" enabled="true">
    <collectionProp name="Asserion.test_strings">
      <stringProp name="0">{expect}</stringProp>
    </collectionProp>
    <stringProp name="Assertion.test_field">Assertion.response_code</stringProp>
    <boolProp name="Assertion.assume_success">false</boolProp>
    <intProp name="Assertion.test_type">2</intProp>
  </ResponseAssertion>
  <hashTree/>
</hashTree>""".format(label=label, path=path, method=method, body_xml=body_xml,
                      post_raw=post_raw, header=header, expect=expect)
    return sampler


def build(name, samplers):
    sampler_block = "\n".join(samplers)
    tmpl = """<?xml version="1.0" encoding="UTF-8"?>
<jmeterTestPlan version="1.2" properties="5.0">
  <hashTree>
    <TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="{name}" enabled="true">
      <stringProp name="TestPlan.comments"></stringProp>
      <boolProp name="TestPlan.functional_mode">false</boolProp>
      <boolProp name="TestPlan.tearDown_on_shutdown">true</boolProp>
      <boolProp name="TestPlan.serialize_threadgroups">false</boolProp>
      <elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
        <collectionProp name="Arguments.arguments"/>
      </elementProp>
      <stringProp name="TestPlan.user_define_classpath"></stringProp>
    </TestPlan>
    <hashTree>
      <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="TG" enabled="true">
        <stringProp name="ThreadGroup.on_sample_error">continue</stringProp>
        <elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" testclass="LoopController" testname="Loop Controller" enabled="true">
          <boolProp name="LoopController.continue_forever">false</boolProp>
          <stringProp name="LoopController.loops">${{__P(loops,-1)}}</stringProp>
        </elementProp>
        <stringProp name="ThreadGroup.num_threads">${{__P(threads,10)}}</stringProp>
        <stringProp name="ThreadGroup.ramp_time">${{__P(rampUp,10)}}</stringProp>
        <boolProp name="ThreadGroup.scheduler">true</boolProp>
        <stringProp name="ThreadGroup.duration">${{__P(duration,60)}}</stringProp>
        <stringProp name="ThreadGroup.delay">0</stringProp>
        <boolProp name="ThreadGroup.same_user_on_next_iteration">true</boolProp>
      </ThreadGroup>
      <hashTree>
        <ConfigTestElement guiclass="HttpDefaultsGui" testclass="ConfigTestElement" testname="HTTP Request Defaults" enabled="true">
          <elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" testclass="Arguments" testname="User Defined Variables" enabled="true">
            <collectionProp name="Arguments.arguments"/>
          </elementProp>
          <stringProp name="HTTPSampler.domain">{host}</stringProp>
          <stringProp name="HTTPSampler.port">{port}</stringProp>
          <stringProp name="HTTPSampler.protocol">http</stringProp>
          <stringProp name="HTTPSampler.contentEncoding"></stringProp>
          <stringProp name="HTTPSampler.path"></stringProp>
          <stringProp name="HTTPSampler.concurrentPool">4</stringProp>
          <stringProp name="HTTPSampler.connect_timeout"></stringProp>
          <stringProp name="HTTPSampler.response_timeout"></stringProp>
        </ConfigTestElement>
        <hashTree/>
{samplers}
        {summary}
        {aggregate}
      </hashTree>
    </hashTree>
  </hashTree>
</jmeterTestPlan>"""
    summary = LISTENER.format(gui="SummaryReport", name="Summary Report", save=SAVE_CONFIG)
    aggregate = LISTENER.format(gui="AggregateReport", name="Aggregate Report", save=SAVE_CONFIG)
    return tmpl.format(name=name, host=HOST, port=PORT, samplers=sampler_block,
                       summary=summary, aggregate=aggregate)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    config_body = '{"llmModel":"Qwen/Qwen3-8B-${__counter(,)}","llmEnabled":true}'
    llm_body = '{"model":"Qwen/Qwen3-8B","messages":[{"role":"user","content":"ping"}],"stream":false,"max_tokens":32}'
    heygen_body = '{"caption":"测试","avatar_id":"mock"}'
    zhiying_body = '{"text":"你好小雅","avatar":"mock","voice":"mock"}'

    plans = {
        "static.jmx": build("static_index", [
            get_sampler("GET / (index.html)", "/", "GET"),
        ]),
        "config_get.jmx": build("config_get", [
            get_sampler("GET /api/config", "/api/config", "GET"),
        ]),
        "config_post.jmx": build("config_post", [
            get_sampler("POST /api/config", "/api/config", "POST", body=config_body),
        ]),
        "heygen_proxy.jmx": build("heygen_proxy", [
            get_sampler("POST /api/heygen/v3/videos", "/api/heygen/v3/videos", "POST", body=heygen_body),
            get_sampler("GET /api/heygen/v3/videos/mock", "/api/heygen/v3/videos/mock123", "GET"),
        ]),
        "llm_real.jmx": build("llm_real", [
            get_sampler("POST /api/llm (SiliconFlow)", "/api/llm", "POST", body=llm_body),
        ]),
        "zhiying.jmx": build("zhiying", [
            get_sampler("POST /api/zhiying/generate", "/api/zhiying/generate", "POST", body=zhiying_body),
            get_sampler("GET /api/zhiying/status", "/api/zhiying/status?video_id=mock123", "GET"),
        ]),
    }
    for fname, content in plans.items():
        path = os.path.join(here, fname)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print("WROTE", fname)


if __name__ == "__main__":
    main()
